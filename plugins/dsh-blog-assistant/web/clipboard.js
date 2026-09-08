/** Clipboard and drop expose files through the same browser DataTransfer interface. */
export function transferredFiles(transfer){
  const files=[...transfer?.files??[]]
  if(files.length)return files
  return [...transfer?.items??[]].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean)
}
export function attachmentName(file,index=0){
  if(file.name&&/\.[a-z0-9]+$/i.test(file.name))return file.name
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[file.type]
  return ext?`粘贴图片-${Date.now()}-${index+1}.${ext}`:file.name||`粘贴文件-${index+1}`
}
