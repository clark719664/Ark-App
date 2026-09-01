// The curated "open when…" moments, envelope colours, and stationery —
// ported from Open When (openwhen/), Ark's sister product, when its features
// were folded into the time capsule. The writing hints are the soul of it:
// the page should never feel blank.

export interface Moment {
  key: string
  emoji: string
  label: string // completes the sentence "open when …"
  hint: string
}

export interface MomentGroup {
  name: string
  moments: Moment[]
}

export const MOMENT_GROUPS: MomentGroup[] = [
  { name: "Comfort", moments: [
    { key: "sleep", emoji: "🌙", label: "you can't sleep", hint: "Write like a whisper. A memory of a quiet night, and one small thing to try — three slow breaths, one song, warm milk." },
    { key: "hardday", emoji: "🌧️", label: "you've had a hard day", hint: "Don't fix anything. Just be there on paper. Remind them of one thing they already survived." },
    { key: "missme", emoji: "🫂", label: "you miss me", hint: "Describe exactly where you are as you write this — what you can see and hear. It makes the distance smaller." },
    { key: "worried", emoji: "🍵", label: "you're worried", hint: "Name the worry gently, then tell them about a time worry turned out to be lying." },
  ]},
  { name: "Courage", moments: [
    { key: "doubt", emoji: "🔥", label: "you doubt yourself", hint: "List three moments you watched them be braver than they knew. Be specific." },
    { key: "bigday", emoji: "🌅", label: "it's the morning of the big day", hint: "Short and steady. One sentence they can carry in a pocket all day." },
    { key: "walkin", emoji: "🚪", label: "you're about to walk in", hint: "They'll read this in a hallway with a racing heart. Two lines, max. Make them stand taller." },
    { key: "push", emoji: "🏔️", label: "you need a push", hint: "Be the friend who says the true thing — kind, but with no escape hatch." },
  ]},
  { name: "Celebration", moments: [
    { key: "news", emoji: "🎉", label: "the good news arrives", hint: "Write the toast you'd give with a glass in hand. Be embarrassing." },
    { key: "birthday", emoji: "🎂", label: "it's your birthday", hint: "Tell them your favorite thing that happened in their last year — the one they might not even remember." },
    { key: "didit", emoji: "🏆", label: "you did the thing", hint: "Say what you knew back when you sealed this envelope." },
  ]},
  { name: "Distance", moments: [
    { key: "land", emoji: "✈️", label: "you land", hint: "First-day-somewhere-new instructions: eat this, call me when, don't be scared of that." },
    { key: "homesick", emoji: "🏡", label: "you're homesick", hint: "Home smells, home sounds, home nonsense — and when they can next expect the real thing." },
    { key: "firstweek", emoji: "📦", label: "you finish your first week", hint: "Predict, kindly, how it went. You'll be more right than you think." },
  ]},
  { name: "Love & laughter", moments: [
    { key: "loved", emoji: "💌", label: "you forget how loved you are", hint: "The evidence, plainly listed. Dates where possible." },
    { key: "secret", emoji: "🤫", label: "you want to know a secret", hint: "Something true you've never quite said out loud. This is the envelope for it." },
    { key: "laugh", emoji: "😂", label: "you need a laugh", hint: "The inside joke, told badly, in full. Footnotes welcome." },
    { key: "hungry", emoji: "🍜", label: "you're hungry at 2am", hint: "A recipe you two owe to each other — or formal written permission for cereal." },
  ]},
  { name: "Hard days", moments: [
    { key: "hurts", emoji: "🕯️", label: "it hurts", hint: "You can't take it away. You can sit with them here. Say that, plainly." },
    { key: "missthem", emoji: "🤍", label: "you're missing them", hint: "For grief: share a memory of the person they miss — ideally one they've never heard." },
  ]},
  { name: "The end", moments: [
    { key: "last", emoji: "🎁", label: "you open the last letter", hint: "Land the plane. What you hope for them next — and a promise there are more words where these came from." },
  ]},
]

export const ENVELOPE_COLORS = ["rose", "sage", "dusk", "sand", "plum"] as const
export type EnvelopeColor = (typeof ENVELOPE_COLORS)[number]

export const STATIONERY = {
  classic: "Classic",
  hand: "Handwritten",
  type: "Typewriter",
  night: "Moonlight",
} as const
export type Stationery = keyof typeof STATIONERY

export function isEnvelopeColor(v: unknown): v is EnvelopeColor {
  return typeof v === "string" && (ENVELOPE_COLORS as readonly string[]).includes(v)
}

export function isStationery(v: unknown): v is Stationery {
  return typeof v === "string" && v in STATIONERY
}
