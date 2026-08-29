import { describe, expect, it } from 'vitest'
import { findFanPointsColumn, normalizeHeader, playerKeyId, rowPlayerId } from './projections.js'

/** What Yahoo actually sends: the header carries a private-use glyph. */
const FAN_PTS = 'Fan Pts'

describe('header normalisation', () => {
  it('strips the private-use glyph Yahoo appends to sortable headers', () => {
    expect(normalizeHeader(FAN_PTS)).toBe('fan pts')
  })

  it('is not fooled by a header that only looks equal when printed', () => {
    // The bug this guards: these render identically and compare unequal.
    expect(FAN_PTS).not.toBe('Fan Pts')
    expect(normalizeHeader(FAN_PTS)).toBe(normalizeHeader('Fan Pts'))
  })

  it('collapses whitespace and case', () => {
    expect(normalizeHeader('  Pre-Season  ')).toBe('pre-season')
    expect(normalizeHeader('% ROS')).toBe('% ros')
  })
})

describe('finding the projection column', () => {
  const headers = ['', '', 'Offense', 'Roster Status', 'GP*', 'Bye', FAN_PTS, 'Pre-Season', 'Actual']

  it('finds the column by name whatever position it sits in', () => {
    expect(findFanPointsColumn(headers)).toBe(6)
    expect(findFanPointsColumn([FAN_PTS, 'Bye'])).toBe(0)
  })

  it('reports absence rather than guessing when the column is not there', () => {
    expect(findFanPointsColumn(['Offense', 'Bye', 'Pre-Season'])).toBe(-1)
  })
})

describe('reading a player id from a row', () => {
  it('prefers the player page link', () => {
    expect(
      rowPlayerId([
        'https://football.fantasysports.yahoo.com/f1/548882/addplayerwatch?apid=99999',
        'https://sports.yahoo.com/nfl/players/32723',
      ]),
    ).toBe('32723')
  })

  it('falls back to the watchlist link, which is all a defence has', () => {
    expect(
      rowPlayerId([
        'https://football.fantasysports.yahoo.com/f1/548882/addplayerwatch?mid=4&apid=100024&crumb=x',
        'https://sports.yahoo.com/nfl/teams/la-chargers/',
      ]),
    ).toBe('100024')
  })

  it('returns nothing when a row identifies nobody', () => {
    expect(rowPlayerId(['https://sports.yahoo.com/nfl/teams/la-chargers/'])).toBeNull()
  })
})

describe('player keys', () => {
  it('takes the numeric id out of a player key', () => {
    expect(playerKeyId('470.p.32723')).toBe('32723')
    expect(playerKeyId('461.p.100024')).toBe('100024')
  })
})
