/**
 * Narrow, local macOS integrations for JARVIS.
 *
 * This module deliberately accepts structured intents rather than a shell
 * command. A spoken request must match one of the small parsers below before
 * it can touch an application, Calendar, Reminders, Mail, or Downloads.
 */
import { homedir } from 'node:os'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const enabled = () => process.platform === 'darwin' && process.env.JARVIS_ALLOW_MACOS_ACTIONS === '1'

function clean(value, max = 180) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function appName(value) {
  const name = clean(value, 80)
  return /^[\p{L}\p{N} .'-]+$/u.test(name) ? name : null
}

function apple(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function osa(lines, args = []) {
  const flags = lines.flatMap((line) => ['-e', line])
  const { stdout } = await execFile('/usr/bin/osascript', [...flags, '--', ...args], {
    timeout: 12_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

function parseDate(raw) {
  const text = clean(raw).toLowerCase()
  const now = new Date()
  const at = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(text)
  const hourRaw = at ? Number(at[1]) : 9
  const minute = at?.[2] ? Number(at[2]) : 0
  let hour = hourRaw
  if (at?.[3] === 'pm' && hour < 12) hour += 12
  if (at?.[3] === 'am' && hour === 12) hour = 0
  if (text.includes('tomorrow')) now.setDate(now.getDate() + 1)
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (iso) now.setFullYear(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  now.setHours(hour, minute, 0, 0)
  return now
}

function dateArgs(date, durationMinutes = 60) {
  const end = new Date(date.getTime() + durationMinutes * 60_000)
  const fields = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].map(String)
  return [...fields(date), ...fields(end)]
}

function intentFor(text) {
  const said = clean(text)
  const lower = said.toLowerCase()
  const app = /^(?:please )?(open|launch|start|close|quit)\s+(?:the )?(?:app(?:lication)?\s+)?(.+?)[.!?]*$/i.exec(said)
  if (app) return { kind: app[1].match(/close|quit/i) ? 'quit-app' : 'open-app', app: appName(app[2]) }

  const unread = /\b(?:show|tell|read|give|list)\b[\s\S]{0,55}?\b(\d{1,2})?\s*(?:most\s+)?recent\s+unread\s+(?:e-?mails?|messages?)\b/i.exec(said)
  if (unread) return { kind: 'unread-mail', count: Math.max(1, Math.min(10, Number(unread[1]) || 5)) }

  if (/\b(?:what(?:'s| is)|show|read|check|list).{0,35}\b(?:calendar|schedule|appointments?)\b/i.test(lower)) {
    return { kind: 'read-calendar' }
  }

  const event = /\b(?:add|create|schedule)\s+(?:a\s+)?(?:calendar\s+)?(?:event\s+)?(.+?)\s+(?:on|for)\s+(.+)/i.exec(said)
  if (event) return { kind: 'create-event', title: clean(event[1]), when: parseDate(event[2]) }

  if (/\b(?:show|read|list|what(?:'s| is)).{0,35}\breminders?\b/i.test(lower)) {
    return { kind: 'read-reminders' }
  }
  const reminder = /\bremind\s+me\s+to\s+(.+?)(?:\s+(?:on|at|tomorrow)\s+(.+))?$/i.exec(said)
  if (reminder) return { kind: 'create-reminder', title: clean(reminder[1]), when: reminder[2] ? parseDate(reminder[2]) : null }
  return null
}

async function openApp(name) {
  if (!name) throw new Error('Please say the application name.')
  await execFile('/usr/bin/open', ['-a', name], { timeout: 10_000 })
  return `Opening ${name}.`
}

async function quitApp(name) {
  if (!name) throw new Error('Please say the application name.')
  await osa([`tell application "${apple(name)}" to quit`])
  return `Closing ${name}.`
}

async function readCalendar() {
  const text = await osa([
    'set tomorrow to (current date) + (24 * 60 * 60)',
    'tell application "Calendar"',
    'set rows to {}',
    'repeat with c in calendars',
    'repeat with e in (every event of c whose start date is greater than or equal to (current date) and start date is less than or equal to tomorrow)',
    'set end of rows to ((summary of e as text) & " at " & (start date of e as text))',
    'end repeat',
    'end repeat',
    'return rows as text',
    'end tell',
  ])
  return text ? `Your next 24 hours: ${text.replace(/, /g, '. ')}.` : 'Your calendar is clear for the next 24 hours.'
}

async function createEvent(title, when) {
  if (!title) throw new Error('Please include a calendar event title.')
  const args = [title, ...dateArgs(when)]
  await osa([
    'on run argv',
    'set titleText to item 1 of argv',
    'set startDate to current date',
    'set year of startDate to item 2 of argv as integer',
    'set month of startDate to item 3 of argv as integer',
    'set day of startDate to item 4 of argv as integer',
    'set time of startDate to ((item 5 of argv as integer) * hours + (item 6 of argv as integer) * minutes)',
    'set endDate to current date',
    'set year of endDate to item 7 of argv as integer',
    'set month of endDate to item 8 of argv as integer',
    'set day of endDate to item 9 of argv as integer',
    'set time of endDate to ((item 10 of argv as integer) * hours + (item 11 of argv as integer) * minutes)',
    'tell application "Calendar" to tell calendar 1 to make new event with properties {summary:titleText, start date:startDate, end date:endDate}',
    'end run',
  ], args)
  return `Calendar event “${title}” created for ${when.toLocaleString()}.`
}

async function readReminders() {
  const text = await osa([
    'tell application "Reminders"',
    'set rows to {}',
    'repeat with r in reminders of list "Reminders" whose completed is false',
    'set end of rows to (name of r as text)',
    'if (count of rows) is greater than or equal to 8 then exit repeat',
    'end repeat',
    'return rows as text',
    'end tell',
  ])
  return text ? `Your active reminders: ${text.replace(/, /g, '. ')}.` : 'You have no active reminders.'
}

async function createReminder(title, when) {
  if (!title) throw new Error('Please say what you would like to be reminded about.')
  const script = when
    ? ['on run argv', 'set dueDate to current date', 'set year of dueDate to item 2 of argv as integer', 'set month of dueDate to item 3 of argv as integer', 'set day of dueDate to item 4 of argv as integer', 'set time of dueDate to ((item 5 of argv as integer) * hours + (item 6 of argv as integer) * minutes)', 'tell application "Reminders" to tell list "Reminders" to make new reminder with properties {name:(item 1 of argv), remind me date:dueDate}', 'end run']
    : ['on run argv', 'tell application "Reminders" to tell list "Reminders" to make new reminder with properties {name:(item 1 of argv)}', 'end run']
  await osa(script, when ? [title, ...dateArgs(when).slice(0, 5)] : [title])
  return when ? `Reminder created for ${when.toLocaleString()}.` : `Reminder created: ${title}.`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

async function unreadMail(count) {
  const rows = await osa([
    'tell application "Mail"',
    'set unreadMessages to (every message of inbox whose read status is false)',
    'set rows to {}',
    'set n to count of unreadMessages',
    `set limitCount to ${count}`,
    'if n is greater than limitCount then set n to limitCount',
    'repeat with i from 1 to n',
    'set m to item i of unreadMessages',
    'set end of rows to ((sender of m as text) & "|" & (subject of m as text) & "|" & (date received of m as text))',
    'end repeat',
    'return rows as text',
    'end tell',
  ])
  const mails = rows ? rows.split(', ').map((row) => row.split('|').map(clean)) : []
  const items = mails.map(([from, subject, date], index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><div><h2>${escapeHtml(subject || '(no subject)')}</h2><p>${escapeHtml(from || 'Unknown sender')} · ${escapeHtml(date || '')}</p></div></article>`).join('') || '<p class="empty">No unread messages were found.</p>'
  const document = `<!doctype html><html><head><meta charset="utf-8"><title>JARVIS mail brief</title><style>body{margin:0;background:#061116;color:#dffcff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:820px;margin:0 auto;padding:52px}header{border-bottom:2px solid #4de8ff;padding-bottom:24px}h1{letter-spacing:.16em;font-size:30px;margin:0}header p{color:#6feaff}article{display:flex;gap:24px;border-bottom:1px solid #16414d;padding:22px 0}article span{color:#6feaff;font-family:monospace}h2{margin:0 0 8px;font-size:18px}p{margin:0;color:#a9c5ca}.empty{padding:32px 0}</style></head><body><main><header><h1>J.A.R.V.I.S. MAIL BRIEF</h1><p>${new Date().toLocaleString()} · ${mails.length} unread messages</p></header>${items}</main></body></html>`
  const downloads = join(homedir(), 'Downloads')
  await mkdir(downloads, { recursive: true })
  const path = join(downloads, `JARVIS-Mail-Brief-${new Date().toISOString().slice(0, 10)}.doc`)
  await writeFile(path, document, 'utf8')
  return mails.length ? `I found ${mails.length} unread emails and saved a JARVIS mail brief in your Downloads folder.` : 'There are no unread emails. I saved an empty mail brief in your Downloads folder.'
}

export async function runMacIntent(text) {
  const intent = intentFor(text)
  if (!intent) return null
  if (!enabled()) return 'macOS actions are locked. Enable JARVIS_ALLOW_MACOS_ACTIONS=1 in your private .env.local, then relaunch JARVIS.'
  if (intent.kind === 'open-app') return openApp(intent.app)
  if (intent.kind === 'quit-app') return quitApp(intent.app)
  if (intent.kind === 'read-calendar') return readCalendar()
  if (intent.kind === 'create-event') return createEvent(intent.title, intent.when)
  if (intent.kind === 'read-reminders') return readReminders()
  if (intent.kind === 'create-reminder') return createReminder(intent.title, intent.when)
  if (intent.kind === 'unread-mail') return unreadMail(intent.count)
  return null
}

export const macosActionsAvailable = () => enabled()
export const isMacIntent = (text) => Boolean(intentFor(text))
