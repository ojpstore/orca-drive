// 패널의 순수 로직. DOM이 없어 node --test로 검사한다(worker.test.mjs).
export const FOLDER = 'application/vnd.google-apps.folder'
const GOOGLE = 'application/vnd.google-apps.'
export const isDir = (f) => f.mimeType === FOLDER
// Google 문서 종류('document', 'spreadsheet' …). 일반 파일이면 null.
export const googleKind = (f) => (f.mimeType.startsWith(GOOGLE) ? f.mimeType.slice(GOOGLE.length) : null)

// 폴더가 먼저, 그다음 key(name|modified|size) 기준. dir 1 = 오름차순, -1 = 내림차순.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) // 탐색기·Drive처럼 영문이 한글보다 먼저
const KEYS = {
  name: (a, b) => collator.compare(a.name, b.name),
  modified: (a, b) => Date.parse(a.modifiedTime ?? 0) - Date.parse(b.modifiedTime ?? 0),
  size: (a, b) => Number(a.size ?? 0) - Number(b.size ?? 0)
}
export function sortFiles(files, key = 'name', dir = 1) {
  return [...files].sort((a, b) => isDir(b) - isDir(a) || dir * KEYS[key](a, b) || collator.compare(a.name, b.name))
}

// 같은 폴더에 이미 있는 이름이면 'a (1).txt' 식으로 피한다.
export function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let n = name
  for (let i = 1; taken.has(n); i++) n = `${base} (${i})${ext}`
  return n
}

export const withExt = (name, ext) => (name.toLowerCase().endsWith('.' + ext) ? name : `${name}.${ext}`)

// Google 문서를 내려받을 형식: [라벨, export mimeType, 확장자]
const PDF = ['PDF', 'application/pdf', 'pdf']
export const EXPORTS = {
  document: [['Word (.docx)', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'], PDF, ['텍스트 (.txt)', 'text/plain', 'txt']],
  spreadsheet: [['Excel (.xlsx)', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'], ['CSV (첫 시트)', 'text/csv', 'csv'], PDF],
  presentation: [['PowerPoint (.pptx)', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'], PDF],
  drawing: [['PNG', 'image/png', 'png'], PDF]
}

// 불러온 트리에서 이름에 text가 들어간 항목과 그 조상 폴더의 id. 한 폴더가 여러 부모에 있어도 한 번만 돈다.
export function filterTree(kids, rootId, text) {
  const t = text.toLowerCase()
  const show = new Set()
  const seen = new Set()
  const visit = (id) => {
    if (seen.has(id)) return show.has(id)
    seen.add(id)
    let any = false
    for (const f of kids.get(id) ?? []) {
      const sub = isDir(f) && visit(f.id)
      if (sub || f.name.toLowerCase().includes(t)) {
        show.add(f.id)
        any = true
      }
    }
    return any
  }
  visit(rootId)
  return show
}

// Shift 클릭: 화면 순서(order: id 배열)에서 a부터 b까지.
export function rangeIds(order, a, b) {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i < 0 || j < 0) return [b]
  return order.slice(Math.min(i, j), Math.max(i, j) + 1)
}
