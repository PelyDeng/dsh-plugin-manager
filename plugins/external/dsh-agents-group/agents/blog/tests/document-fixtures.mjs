// Small deterministic documents containing real text, not parser mocks.
export function pdf(text='PDF-MARKER-739') {
  const stream=`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let value='%PDF-1.4\n';const offsets=[0]
  for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(value));value+=`${i+1} 0 obj\n${obj}\nendobj\n`}
  const start=Buffer.byteLength(value)
  value+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(value)
}
function crc32(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0)}return (n^0xffffffff)>>>0}
export function zipStored(entries){const files=[],central=[];let offset=0
  for(const [filename,content] of Object.entries(entries)){
    const name=Buffer.from(filename),data=Buffer.from(content),crc=crc32(data),local=Buffer.alloc(30),dir=Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26)
    dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt32LE(crc,16);dir.writeUInt32LE(data.length,20);dir.writeUInt32LE(data.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42)
    files.push(local,name,data);central.push(dir,name);offset+=local.length+name.length+data.length
  }
  const footer=Buffer.alloc(22),directory=Buffer.concat(central);footer.writeUInt32LE(0x06054b50);footer.writeUInt16LE(Object.keys(entries).length,8);footer.writeUInt16LE(Object.keys(entries).length,10);footer.writeUInt32LE(directory.length,12);footer.writeUInt32LE(offset,16)
  return Buffer.concat([...files,directory,footer])
}
export function docx(){return zipStored({
  '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml':'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX-MARKER-281</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格答案：42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
})}
