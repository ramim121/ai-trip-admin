import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGES,
  MAX_OPENING_WINDOWS,
  formatClockTime,
  formatImages,
  formatOpeningHours,
  parseClockTime,
  parseDayToken,
  parseImagesText,
  parseOpeningHoursText,
  slugify,
} from './admin'
import { evaluateOpeningWindows } from './service'

/**
 * The console's text parsers.
 *
 * These sit directly in front of the opening-hours convention: whatever this file
 * produces is what `evaluateOpeningWindows` will later be asked about, so the two
 * have to agree on what "Mon 18:00-26:00" means. The round-trip and end-to-end
 * cases check that agreement rather than trusting each half separately.
 */

function at(hour: number, minute = 0): number {
  return hour * 60 + minute
}

const SUNDAY = 0
const MONDAY = 1
const TUESDAY = 2

describe('parseDayToken', () => {
  it('accepts the spellings a content editor actually types', () => {
    expect(parseDayToken('Sun')).toBe(0)
    expect(parseDayToken('monday')).toBe(1)
    expect(parseDayToken('TUE')).toBe(2)
    expect(parseDayToken('weds')).toBe(3)
    expect(parseDayToken('Thurs.')).toBe(4)
    expect(parseDayToken(' fri ')).toBe(5)
    expect(parseDayToken('Sa')).toBe(6)
  })

  it('accepts the raw index, which is what the database stores', () => {
    expect(parseDayToken('0')).toBe(0)
    expect(parseDayToken('6')).toBe(6)
  })

  it('rejects anything that is not a weekday', () => {
    expect(parseDayToken('7')).toBeNull()
    expect(parseDayToken('someday')).toBeNull()
    expect(parseDayToken('')).toBeNull()
  })
})

describe('parseClockTime', () => {
  it('reads a 24-hour time as minutes from midnight', () => {
    expect(parseClockTime('00:00')).toBe(0)
    expect(parseClockTime('09:30')).toBe(570)
    expect(parseClockTime('9:30')).toBe(570)
    expect(parseClockTime('23:59')).toBe(1439)
  })

  it('reads an hour past 24 as running into the next day', () => {
    // The convention the schema documents: 26:00 is 02:00 tomorrow.
    expect(parseClockTime('24:00')).toBe(1440)
    expect(parseClockTime('26:00')).toBe(1560)
  })

  it('rejects nonsense', () => {
    expect(parseClockTime('9')).toBeNull()
    expect(parseClockTime('09:60')).toBeNull()
    expect(parseClockTime('48:00')).toBeNull()
    expect(parseClockTime('9:30pm')).toBeNull()
  })

  it('round-trips with formatClockTime', () => {
    for (const minute of [0, 570, 1439, 1440, 1560]) {
      expect(parseClockTime(formatClockTime(minute))).toBe(minute)
    }
  })
})

describe('parseOpeningHoursText', () => {
  it('parses one plain line', () => {
    const { windows, errors } = parseOpeningHoursText('Mon 09:00-17:00')

    expect(errors).toEqual([])
    expect(windows).toEqual([{ dayOfWeek: MONDAY, opensMinute: at(9), closesMinute: at(17) }])
  })

  it('expands a day range into one window per day', () => {
    const { windows, errors } = parseOpeningHoursText('Mon-Fri 09:00-17:00')

    expect(errors).toEqual([])
    expect(windows).toHaveLength(5)
    expect(windows.map((window) => window.dayOfWeek)).toEqual([1, 2, 3, 4, 5])
    expect(windows.every((window) => window.opensMinute === at(9))).toBe(true)
  })

  it('wraps a range across the end of the week', () => {
    // A bar open Friday through Monday describes itself that way. Refusing the
    // wrap would make it two lines for one idea.
    const { windows, errors } = parseOpeningHoursText('Fri-Mon 18:00-23:00')

    expect(errors).toEqual([])
    expect([...windows.map((window) => window.dayOfWeek)].sort()).toEqual([0, 1, 5, 6])
  })

  it('expands Daily to all seven', () => {
    const { windows, errors } = parseOpeningHoursText('Daily 05:00-20:00')

    expect(errors).toEqual([])
    expect(windows.map((window) => window.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('accepts a comma-separated list', () => {
    const { windows, errors } = parseOpeningHoursText('Mon,Wed,Fri 10:00-14:00')

    expect(errors).toEqual([])
    expect(windows.map((window) => window.dayOfWeek)).toEqual([1, 3, 5])
  })

  it('keeps a midday break as two windows rather than merging them', () => {
    const { windows, errors } = parseOpeningHoursText('Tue 09:00-12:00\nTue 14:00-18:00')

    expect(errors).toEqual([])
    expect(windows).toEqual([
      { dayOfWeek: TUESDAY, opensMinute: at(9), closesMinute: at(12) },
      { dayOfWeek: TUESDAY, opensMinute: at(14), closesMinute: at(18) },
    ])
  })

  it('carries a past-midnight close through as a minute above 1440', () => {
    const { windows, errors } = parseOpeningHoursText('Mon 18:00-26:00')

    expect(errors).toEqual([])
    expect(windows).toEqual([{ dayOfWeek: MONDAY, opensMinute: 1080, closesMinute: 1560 }])
  })

  it('treats an empty box as always available, not as an error', () => {
    // This is how a public beach is recorded. An empty result with no complaint
    // is the correct answer, and the form says as much beside the field.
    expect(parseOpeningHoursText('')).toEqual({ windows: [], errors: [] })
    expect(parseOpeningHoursText('   \n\n  ')).toEqual({ windows: [], errors: [] })
  })

  it('skips blank lines and comments', () => {
    const { windows, errors } = parseOpeningHoursText(
      '# Winter season only\n\nMon 09:00-17:00\n\n# shut for Eid\n'
    )

    expect(errors).toEqual([])
    expect(windows).toHaveLength(1)
  })

  it('reports every bad line, not just the first', () => {
    const { windows, errors } = parseOpeningHoursText(
      'Mon 09:00-17:00\nSomeday 09:00-17:00\nTue 25:00\nWed 17:00-09:00'
    )

    expect(windows).toHaveLength(1)
    expect(errors).toHaveLength(3)
    expect(errors[0]).toContain('Line 2')
    expect(errors[1]).toContain('Line 3')
    expect(errors[2]).toContain('Line 4')
  })

  it('explains how to write a venue that closes after midnight', () => {
    const { errors } = parseOpeningHoursText('Wed 18:00-02:00')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('26:00')
  })

  it('refuses an opening time that is itself past midnight', () => {
    const { windows, errors } = parseOpeningHoursText('Mon 25:00-27:00')

    expect(windows).toHaveLength(0)
    expect(errors[0]).toContain('before 24:00')
  })

  it('refuses a window running past the following midnight', () => {
    expect(parseOpeningHoursText('Mon 10:00-49:00').errors).toHaveLength(1)
  })

  it('caps the number of windows a single paste can create', () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `Daily 0${index % 9}:00-0${index % 9}:30`
    ).join('\n')

    const { errors } = parseOpeningHoursText(text)
    expect(errors.some((error) => error.includes(String(MAX_OPENING_WINDOWS)))).toBe(true)
  })
})

describe('formatOpeningHours', () => {
  it('groups a contiguous run back into the range it was typed as', () => {
    const { windows } = parseOpeningHoursText('Mon-Fri 09:00-17:00')
    expect(formatOpeningHours(windows)).toBe('Mon-Fri 09:00-17:00')
  })

  it('renders all seven days as Daily', () => {
    const { windows } = parseOpeningHoursText('Daily 05:00-20:00')
    expect(formatOpeningHours(windows)).toBe('Daily 05:00-20:00')
  })

  it('leaves a non-contiguous set as a list', () => {
    const { windows } = parseOpeningHoursText('Mon,Wed,Fri 10:00-14:00')
    expect(formatOpeningHours(windows)).toBe('Mon,Wed,Fri 10:00-14:00')
  })

  it('keeps a midday break on two lines', () => {
    const { windows } = parseOpeningHoursText('Tue 09:00-12:00\nTue 14:00-18:00')
    expect(formatOpeningHours(windows)).toBe('Tue 09:00-12:00\nTue 14:00-18:00')
  })

  it('renders an empty schedule as an empty box', () => {
    expect(formatOpeningHours([])).toBe('')
  })

  it('survives a parse, format, parse round trip', () => {
    // An editor who opens a record and saves it unchanged must not find their
    // input rewritten into something that parses differently.
    for (const source of [
      'Mon-Fri 09:00-17:00',
      'Daily 05:00-20:00',
      'Mon,Wed,Fri 10:00-14:00',
      'Tue 09:00-12:00\nTue 14:00-18:00',
      'Mon 18:00-26:00',
      'Fri-Mon 18:00-23:00',
    ]) {
      const first = parseOpeningHoursText(source).windows
      const second = parseOpeningHoursText(formatOpeningHours(first)).windows
      expect(second).toEqual(first)
    }
  })
})

describe('opening hours agree with the availability rule', () => {
  it('parses a night market that the checker then reads on the following morning', () => {
    // The end-to-end version of the trickiest case: a console entry of
    // "Mon 18:00-26:00" has to make a 01:00 Tuesday block come back open.
    const { windows } = parseOpeningHoursText('Mon 18:00-26:00')

    expect(evaluateOpeningWindows(windows, TUESDAY, at(0, 30), at(1, 30)).isOpen).toBe(true)
    expect(evaluateOpeningWindows(windows, TUESDAY, at(2, 30), at(3)).isOpen).toBe(false)
    expect(evaluateOpeningWindows(windows, MONDAY, at(19), at(21)).isOpen).toBe(true)
  })

  it('makes an empty box mean always open, all week', () => {
    const { windows } = parseOpeningHoursText('')

    for (let day = 0; day <= 6; day += 1) {
      expect(evaluateOpeningWindows(windows, day, at(3), at(4)).reason).toBe('ALWAYS_OPEN')
    }
  })

  it('makes a weekday absent from the box closed that day', () => {
    const { windows } = parseOpeningHoursText('Mon-Fri 09:00-17:00')

    expect(evaluateOpeningWindows(windows, MONDAY, at(10), at(11)).isOpen).toBe(true)
    expect(evaluateOpeningWindows(windows, SUNDAY, at(10), at(11)).reason).toBe('CLOSED_ON_DAY')
  })
})

describe('parseImagesText', () => {
  it('parses url and alt, numbering in the order they were listed', () => {
    const { images, errors } = parseImagesText(
      'https://cdn.example.com/a.jpg | Boats drawn up on the sand\n' +
        '/uploads/b.jpg | The watchtower path at first light'
    )

    expect(errors).toEqual([])
    expect(images).toEqual([
      { url: 'https://cdn.example.com/a.jpg', alt: 'Boats drawn up on the sand', sortOrder: 0 },
      { url: '/uploads/b.jpg', alt: 'The watchtower path at first light', sortOrder: 1 },
    ])
  })

  it('refuses an image with no alt text rather than storing an empty one', () => {
    // The column is required precisely so this cannot be skipped; storing "" to
    // satisfy the constraint would defeat the reason it exists.
    const { images, errors } = parseImagesText('https://cdn.example.com/a.jpg |')

    expect(images).toEqual([])
    expect(errors[0]).toContain('alt text is required')
  })

  it('refuses a line with no separator', () => {
    expect(parseImagesText('https://cdn.example.com/a.jpg').errors[0]).toContain('|')
  })

  it('refuses something that is neither a URL nor a rooted path', () => {
    expect(parseImagesText('cdn.example.com/a.jpg | A beach').errors).toHaveLength(1)
  })

  it('refuses the same URL twice', () => {
    const { images, errors } = parseImagesText(
      'https://cdn.example.com/a.jpg | One\nhttps://cdn.example.com/a.jpg | Two'
    )

    expect(images).toHaveLength(1)
    expect(errors[0]).toContain('already listed')
  })

  it('caps the number of images', () => {
    const text = Array.from(
      { length: MAX_IMAGES + 2 },
      (_, index) => `https://cdn.example.com/${index}.jpg | Photo ${index}`
    ).join('\n')

    expect(parseImagesText(text).errors.some((error) => error.includes('At most'))).toBe(true)
  })

  it('round-trips through formatImages', () => {
    const source =
      'https://cdn.example.com/a.jpg | Boats on the sand\n/uploads/b.jpg | The watchtower path'

    expect(formatImages(parseImagesText(source).images)).toBe(source)
  })

  it('treats an empty box as no images', () => {
    expect(parseImagesText('')).toEqual({ images: [], errors: [] })
  })
})

describe('slugify', () => {
  it('makes a URL-safe slug from a display name', () => {
    expect(slugify('Himchari National Park & Waterfall')).toBe('himchari-national-park-waterfall')
  })

  it('leaves no leading, trailing or doubled hyphens', () => {
    expect(slugify('  --  Sunset Walk  --  ')).toBe('sunset-walk')
  })

  it('produces something the slug pattern accepts', () => {
    for (const name of ["Saint Martin's Island Day Trip", 'Inani & Patuartek', '  Spa  ']) {
      expect(slugify(name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })
})
