import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)), 'utf8').replaceAll('\r\n', '\n')
}

export const webHtml = read('index.html')
export const webStyles = read('app.css')
export const webTrajectory = read('trajectory.js')
export const webApp = read('app.js')
export const webSource = `${webHtml}\n${webStyles}\n${webTrajectory}\n${webApp}`
