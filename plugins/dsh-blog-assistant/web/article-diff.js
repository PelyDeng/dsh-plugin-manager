/** Line comparison with bounded work for long articles. Oversized middle sections stay grouped. */
export function articleDiff(before='',after=''){
  const a=before.split('\n'),b=after.split('\n'),rows=[]
  const add=(kind,text)=>{const last=rows.at(-1);if(last?.kind===kind)last.lines.push(text);else rows.push({kind,lines:[text]})}
  let start=0,endA=a.length,endB=b.length
  while(start<endA&&start<endB&&a[start]===b[start]){add('same',a[start]);start++}
  while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--}
  const n=endA-start,m=endB-start
  if(!n||!m||n*m>1_000_000){for(let i=start;i<endA;i++)add('removed',a[i]);for(let j=start;j<endB;j++)add('added',b[j])}
  else{
    const lengths=Array.from({length:n+1},()=>new Uint32Array(m+1))
    for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)lengths[i][j]=a[start+i]===b[start+j]?1+lengths[i+1][j+1]:Math.max(lengths[i+1][j],lengths[i][j+1])
    let i=0,j=0
    while(i<n||j<m){
      if(i<n&&j<m&&a[start+i]===b[start+j]){add('same',a[start+i++]);j++}
      else if(i<n&&(j===m||lengths[i+1][j]>=lengths[i][j+1]))add('removed',a[start+i++])
      else add('added',b[start+j++])
    }
  }
  for(let i=endA;i<a.length;i++)add('same',a[i])
  return rows
}
