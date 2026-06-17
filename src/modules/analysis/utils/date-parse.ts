export function parseISOWeek(weekStr: string): Date {
  const match = weekStr.match(/^(\d{4})-W(\d{2})$/)
  if (!match) {
    throw new Error('Invalid ISO week format')
  }
  const year = parseInt(match[1]!, 10)
  const week = parseInt(match[2]!, 10)

  // Jan 4th is always in ISO Week 1 of that year
  const jan4 = new Date(Date.UTC(year, 0, 4, 0, 0, 0, 0))
  const day = jan4.getUTCDay()
  const monday1 = new Date(jan4)
  monday1.setUTCDate(jan4.getUTCDate() - day + (day === 0 ? -6 : 1))

  const targetMonday = new Date(monday1)
  targetMonday.setUTCDate(monday1.getUTCDate() + (week - 1) * 7)
  return targetMonday
}

export function parseISOMonth(monthStr: string): Date {
  const match = monthStr.match(/^(\d{4})-(\d{2})$/)
  if (!match) {
    throw new Error('Invalid ISO month format')
  }
  const year = parseInt(match[1]!, 10)
  const month = parseInt(match[2]!, 10)
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0))
}
