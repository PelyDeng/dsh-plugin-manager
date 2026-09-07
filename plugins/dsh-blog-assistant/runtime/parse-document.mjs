import { parentPort, workerData } from 'node:worker_threads'
import yauzl from 'yauzl'
import mammoth from 'mammoth'

const MAX_EXPANDED = 64 * 1024 * 1024
const MAX_CHARS = 240000
function fail(message) { throw new Error(message) }
// Validate actual decompressed bytes before passing a bounded archive to Mammoth.
async function validateDocx(buffer) {
  await new Promise((resolve,reject) => yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip) => {
    if(error)return reject(new Error('DOCX 文件损坏'))
    let total=0,count=0,hasDocument=false,settled=false
    const stop=e=>{if(settled)return;settled=true;zip.close();reject(e)}
    zip.on('error',stop);zip.on('end',()=>{if(!hasDocument)return stop(new Error('不是有效的 DOCX 文档'));settled=true;resolve()})
    zip.on('entry',entry=>{
      if(++count>2000 || entry.uncompressedSize>MAX_EXPANDED || (entry.generalPurposeBitFlag&1))return stop(new Error('DOCX 展开大小或条目超过限制，或文件已加密'))
      if(entry.fileName==='word/document.xml')hasDocument=true
      if(/vbaProject|\.bin$/i.test(entry.fileName))return stop(new Error('不支持包含宏或嵌入对象的文档'))
      if(entry.fileName.endsWith('/'))return zip.readEntry()
      zip.openReadStream(entry,(e,stream)=>{
        if(e)return stop(e)
        stream.on('error',stop);stream.on('data',chunk=>{total+=chunk.length;if(total>MAX_EXPANDED){stream.destroy();stop(new Error('DOCX 展开大小超过 64 MiB'))}})
        stream.on('end',()=>{if(!settled)zip.readEntry()})
      })
    });zip.readEntry()
  }))
}
export async function parseDocument(bytes,kind) {
  const buffer=Buffer.from(bytes);let units=[],totalUnits=0,unit='行',partial=false
  if(kind==='pdf') {
    if(!buffer.subarray(0,8).toString().startsWith('%PDF-'))fail('文件内容不是 PDF')
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,stopAtErrors:true})
    try {
      const pdf=await loading.promise;totalUnits=pdf.numPages;unit='页';let chars=0
      for(let n=1;n<=Math.min(pdf.numPages,200);n++) {
        const page=await pdf.getPage(n),content=await page.getTextContent()
        const text=content.items.map(v=>v.str+(v.hasEOL?'\n':' ')).join('')
        if(chars+text.length>MAX_CHARS){partial=true;break}
        units.push({number:n,text});chars+=text.length;page.cleanup()
      }
      partial ||= units.length<totalUnits
      if(!units.some(u=>u.text.trim()))fail('PDF 没有可读取的文本层，需要 OCR 后再上传')
    } finally { await loading.destroy() }
  } else {
    let text
    if(kind==='docx') {
      await validateDocx(buffer)
      text=(await mammoth.extractRawText({buffer},{externalFileAccess:false})).value;unit='段'
    } else {
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer)}catch{fail('仅支持 UTF-8 文本，请转换编码后上传')}
      if(text.includes('\0'))fail('文件包含二进制内容')
      if(kind==='json'){try{JSON.parse(text)}catch{fail('JSON 格式无效')}}
    }
    const parts=text.split(kind==='docx'?/\n\s*\n/:/\r?\n/);totalUnits=parts.length;let chars=0
    for(const [i,p] of parts.entries()) {
      if(chars+p.length>MAX_CHARS || units.length>=10000){partial=true;break}
      units.push({number:i+1,text:p});chars+=p.length
    }
    if(!units.some(u=>u.text.trim()))fail('没有可读取的文字')
  }
  return {units,totalUnits,unit,partial,characters:units.reduce((n,u)=>n+u.text.length,0)}
}
if(parentPort)parseDocument(workerData.bytes,workerData.kind).then(result=>parentPort.postMessage({ok:true,result}),error=>parentPort.postMessage({ok:false,message:error.message})).finally(()=>parentPort.close())
