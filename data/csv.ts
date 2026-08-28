/**
 * A small RFC 4180 CSV reader.
 *
 * nflverse files contain quoted fields with commas in them — player names,
 * mostly — so splitting on commas silently shifts every column after the first
 * such row. That failure is quiet and produces plausible-looking nonsense,
 * which is the worst kind, so the parser handles quoting properly.
 */

export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }

  fields.push(current)
  return fields
}

export interface CsvTable {
  headers: string[]
  rows: string[][]
  index: Map<string, number>
}

export function parseCsv(text: string): CsvTable {
  const lines = text.split('\n')
  const headers = parseCsvLine(lines[0] ?? '')
  const index = new Map(headers.map((header, i) => [header, i]))

  const rows: string[][] = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line || line.trim() === '') continue
    rows.push(parseCsvLine(line))
  }

  return { headers, rows, index }
}

/** Column accessors that fail loudly on a missing column rather than silently. */
export function column(table: CsvTable, name: string): number {
  const found = table.index.get(name)
  if (found === undefined) {
    throw new Error(
      `Column "${name}" not found. Available: ${table.headers.slice(0, 40).join(', ')}…`,
    )
  }
  return found
}

export function optionalColumn(table: CsvTable, name: string): number | null {
  return table.index.get(name) ?? null
}

export function num(row: string[], index: number | null): number | undefined {
  if (index === null) return undefined
  const raw = row[index]
  if (raw === undefined || raw === '' || raw === 'NA') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function str(row: string[], index: number | null): string {
  if (index === null) return ''
  const raw = row[index]
  return raw === undefined || raw === 'NA' ? '' : raw
}
