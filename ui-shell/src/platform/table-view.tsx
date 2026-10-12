/**
 * 表格视图：csv/tsv（papaparse）与 xlsx/xlsm（SheetJS）两类文件预览。
 *
 * 从旧渲染层 `file-preview.tsx` 的 CsvView / XlsxView 移植（首行当表头、行/列截断
 * 500×100、多 sheet 页签、解析中/解析失败占位），作为 `@dsc/ui` web 值面转出，
 * 文件预览插件直接用。两个解析库都走 dynamic import：点开对应类型的文件才加载
 * 对应懒 chunk，首屏与别的预览不受影响。
 *
 * @module dsc-ui-shell/platform/table-view
 */
import { useEffect, useRef, useState, type JSX } from 'react'

/** 表格类预览的行 / 列截断。 */
const TABLE_MAX_ROWS = 500
const TABLE_MAX_COLS = 100

/** 占位行（解析中 / 失败）——与旧界面 NoticeLine 同一份 class 与位置。 */
function NoticeLine({ message }: { message: string }): JSX.Element {
  return <div className="file-preview-empty">{message}</div>
}

/** 行/列截断判定 + 切片（两个视图共用的一段）。 */
function shapeRows(rows: string[][]): { head: string[] | undefined; body: string[][]; truncated: boolean } {
  const truncated = rows.length > TABLE_MAX_ROWS || rows.some((row) => row.length > TABLE_MAX_COLS)
  const shown = rows.slice(0, TABLE_MAX_ROWS).map((row) => row.slice(0, TABLE_MAX_COLS))
  const [head, ...body] = shown
  return { head, body, truncated }
}

/** 表格本体（表头吸顶 + 斑马纹在 legacy views.css 里，这里只出结构）。
    `lead` 是表格上方的那一块（xlsx 的多 sheet 页签），与截断提示同住一个包裹层。 */
function TableBody({ rows, lead }: { rows: string[][]; lead?: JSX.Element }): JSX.Element {
  const { head, body, truncated } = shapeRows(rows)
  return (
    <div className="file-table-wrap">
      {lead}
      {truncated && (
        <div className="tree-note" data-tree-note="truncated">
          表格较大，仅显示前 {TABLE_MAX_ROWS} 行 × {TABLE_MAX_COLS} 列
        </div>
      )}
      <table className="file-table">
        {head !== undefined && (
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** csv/tsv 视图：papaparse 解析（csv 自动嗅探分隔符，tsv 显式制表符），首行当表头。 */
export function CsvView({ text, path }: { text: string; path: string }): JSX.Element {
  const [rows, setRows] = useState<string[][] | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let on = true
    setRows(null)
    setFailed('')
    void import('papaparse')
      .then((Papa) => {
        const result = Papa.parse(text.replace(/\r\n/g, '\n'), {
          delimiter: path.toLowerCase().endsWith('.tsv') ? '\t' : undefined,
        })
        if (on) setRows(result.data as string[][])
      })
      .catch((error: unknown) => {
        if (on) setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      on = false
    }
  }, [text, path])
  if (failed !== '') return <NoticeLine message={`解析失败：${failed}`} />
  if (rows === null) return <NoticeLine message="解析中…" />
  return <TableBody rows={rows} />
}

/**
 * xlsx 视图：SheetJS 读工作簿（从 fs-read 的 base64），多 sheet 页签切换。
 * 工作簿缓存在 ref 里——切 sheet 只做 sheet_to_json，不重新解析整本文件。
 */
export function XlsxView({ base64 }: { base64: string }): JSX.Element {
  const [sheets, setSheets] = useState<string[] | null>(null)
  const [active, setActive] = useState(0)
  const [rows, setRows] = useState<string[][]>([])
  const [failed, setFailed] = useState('')
  const workbookRef = useRef<import('xlsx').WorkBook | null>(null)
  const showSheet = (index: number): void => {
    void import('xlsx').then((XLSX) => {
      const workbook = workbookRef.current
      const sheet = workbook?.Sheets[workbook.SheetNames[index] ?? '']
      if (sheet === undefined) return
      setRows(
        (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][]).map((row) =>
          row.map((cell) => String(cell ?? '')),
        ),
      )
    })
  }
  useEffect(() => {
    let on = true
    setSheets(null)
    setFailed('')
    setActive(0)
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    void import('xlsx')
      .then((XLSX) => {
        const workbook = XLSX.read(bytes, { type: 'array' })
        if (!on) return
        workbookRef.current = workbook
        setSheets(workbook.SheetNames)
        showSheet(0)
      })
      .catch((error: unknown) => {
        if (on) setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      on = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base64])
  const pick = (index: number): void => {
    setActive(index)
    setFailed('')
    showSheet(index)
  }
  if (failed !== '') return <NoticeLine message={`解析失败：${failed}`} />
  if (sheets === null) return <NoticeLine message="解析中…" />
  const tabs =
    sheets.length > 1 ? (
      <div className="file-sheets">
        {sheets.map((name, index) => (
          <button key={name} type="button" className={`file-sheet${index === active ? ' on' : ''}`} onClick={() => pick(index)}>
            {name}
          </button>
        ))}
      </div>
    ) : undefined
  return <TableBody rows={rows} lead={tabs} />
}
