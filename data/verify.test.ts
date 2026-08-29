import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.js'
import { auditColumns } from './verify.js'

const COLUMNS = {
  receiving_yards: ['receiving_yards', 'rec_yards'],
  receptions: ['receptions', 'rec'],
  def_safeties: ['def_safeties'],
} as const

describe('auditing stat columns', () => {
  it('passes a file where every column carries data', () => {
    const table = parseCsv(
      'id,receiving_yards,receptions,def_safeties\n' + 'a,100,8,0\n' + 'b,0,0,1\n',
    )
    expect(auditColumns(table, COLUMNS)).toEqual({ absent: [], empty: [] })
  })

  it('names a column that is not there', () => {
    const table = parseCsv('id,receptions,def_safeties\na,8,1\n')
    const { absent, empty } = auditColumns(table, COLUMNS)
    expect(absent).toEqual(['receiving_yards'])
    expect(empty).toEqual([])
  })

  /**
   * The failure presence alone would miss. A column of zeroes resolves, scores
   * nothing, and leaves every player quietly short - which is the shape of the
   * data that put a starting back on a draft board at three points a game.
   */
  it('catches a column that is present but never populated', () => {
    const table = parseCsv(
      'id,receiving_yards,receptions,def_safeties\n' + 'a,0,8,0\n' + 'b,0,4,1\n',
    )
    const { absent, empty } = auditColumns(table, COLUMNS)
    expect(absent).toEqual([])
    expect(empty).toEqual(['receiving_yards'])
  })

  it('treats an empty string the same as a zero', () => {
    const table = parseCsv('id,receiving_yards,receptions,def_safeties\na,,8,1\n')
    expect(auditColumns(table, COLUMNS).empty).toEqual(['receiving_yards'])
  })

  it('accepts the alternative spelling without calling the column absent', () => {
    const table = parseCsv('id,rec_yards,rec,def_safeties\na,100,8,1\n')
    expect(auditColumns(table, COLUMNS)).toEqual({ absent: [], empty: [] })
  })

  it('does not require a rare event on every row', () => {
    // One safety in a whole file is enough; demanding more would fail a real one.
    const rows = ['id,receiving_yards,receptions,def_safeties']
    for (let i = 0; i < 200; i++) rows.push(`p${i},50,4,0`)
    rows.push('p200,50,4,1')
    expect(auditColumns(parseCsv(rows.join('\n') + '\n'), COLUMNS).empty).toEqual([])
  })
})
