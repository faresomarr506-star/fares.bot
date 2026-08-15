const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')

const DEFAULT_EMOJIS = ['❤️']
const MAX_REACTION_LOGS = 80
const MAX_COMMENTS = 200
const PANEL_TOKEN_BYTES = 32
const ONE_DAY_MS = 24 * 60 * 60 * 1000

const STORE_OFFERS = [
  {
    key: 'vip_7d',
    title: 'VIP لمدة 7 أيام',
    description: 'تفعيل مزايا VIP للرقم لمدة 7 أيام.',
    price: 120,
    durationDays: 7,
  },
  {
    key: 'vip_30d',
    title: 'VIP لمدة 30 يوم',
    description: 'تفعيل مزايا VIP كاملة لمدة شهر.',
    price: 350,
    durationDays: 30,
  },
  {
    key: 'status_boost_30d',
    title: 'تعزيز الحالات لمدة 30 يوم',
    description: 'إبقاء تفاعل الحالات مفعل مع أولوية تشغيل ومراقبة مستمرة.',
    price: 180,
    durationDays: 30,
  },
]

const file = config.DB_FILE
let data = {
  users: {},
  comments: [],
  metrics: {
    totalStatusReactions: 0,
    totalStatusViews: 0,
    totalPairingCodesIssued: 0,
    totalSuccessfulLinks: 0,
    totalReconnects: 0,
    totalSelfMessages: 0,
    totalBroadcastsTelegram: 0,
    totalBroadcastsWhatsapp: 0,
    totalBroadcastRecipientsTelegram: 0,
    totalBroadcastRecipientsWhatsapp: 0,
  },
  lastUpdatedAt: new Date().toISOString(),
}

function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeUserId(value) {
  return String(value ?? '').trim()
}

function normalizeNumber(raw) {
  return String(raw || '').replace(/\D/g, '')
}

function uniqueArray(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function normalizeReactionEmojis(input) {
  let list = []
  if (Array.isArray(input)) list = input
  else if (typeof input === 'string') {
    list = input
      .split(/[\s,|]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  list = uniqueArray(list)
  return list.length ? list : [...DEFAULT_EMOJIS]
}

function emojisText(emojis) {
  return normalizeReactionEmojis(emojis).join(' ')
}

function boolToOnOff(value) {
  return value === false ? 'off' : 'on'
}

function onOffToBool(value, fallback = true) {
  if (value == null || value === '') return fallback
  return String(value).trim().toLowerCase() === 'on'
}

function getDefaultSettings(number) {
  return {
    name: 'Fares Bot',
    ownerNumber: number || '',
    ownername: 'مالك الرقم',
    description: 'بوت واتساب للتفاعل التلقائي مع الحالات مع حفظ الجلسات بشكل دائم.',
    from: 'Yemen',
    age: '24',
    prefix: '.',
    footer2: 'Fares Bot',
    mode: 'private',
    language: 'arabic',

    antiBad: 'off',
    antiLink: 'off',
    antiSpam: 'off',
    antiGroupAdd: 'off',
    antiPrivateMessages: 'off',
    alwaysOnline: 'on',
    autoTyping: 'off',
    autoRecording: 'off',
    autoRead: 'on',
    autoReact: 'on',
    autoPrivateReact: 'off',
    autoVoice: 'off',
    autoBlock: 'off',
    autoSave: 'on',
    ghostMode: 'off',
    antiViewOnce: 'off',

    autoStatusRead: 'on',
    autoStatusReact: 'on',
    statusReactionNotice: 'on',
    statusViewBoost: 'on',
    statusMsgSend: 'off',
    statusMsgType: 'default',
    customMsg: '',
    statusCustomReact: emojisText(DEFAULT_EMOJIS),
    customAutoReplies: '',
    aiReplyScope: 'inbox',
    autoReactScope: 'both',
    aliveMsg: '✅ البوت يعمل بنجاح',
    voiceFooter: '',

    menu: '',
    alive: '',
    owner: '',

    antiCall: 'off',
    excludeCallNumbers: '',
    antiDelete: 'off',
    antiDeleteMessages: 'off',
    saveDeletedMessageMedia: 'off',
    sendDeleteTo: 'owner',
    keepDeletedStatus: 'off',
    saveDeletedStatusMedia: 'off',
    deletedStatusArchiveSize: '0',
    deletedMessageArchiveSize: '0',

    antiBug: 'off',
    antiBot: 'off',
    antiBotAction: 'delete',
    antiBadWords: '',
    antiLinkList: '',
    antiMention: 'off',
    antiEdit: 'off',
    antiAction: 'warn',
    antiWarnCount: '3',

    gaGroupJid: '',
    gaTimezone: 'Asia/Aden',
    gaCloseTime: '15:00',
    gaOpenTime: '05:00',
  }
}

function buildDefaultWallet() {
  return {
    balance: 0,
    totalClaimed: 0,
    totalSpent: 0,
    lastDailyClaimAt: 0,
    transactions: [],
    features: [],
  }
}

function normalizeWallet(wallet = {}) {
  return {
    balance: Number(wallet.balance || 0),
    totalClaimed: Number(wallet.totalClaimed || 0),
    totalSpent: Number(wallet.totalSpent || 0),
    lastDailyClaimAt: Number(wallet.lastDailyClaimAt || 0),
    transactions: Array.isArray(wallet.transactions) ? wallet.transactions.slice(-120) : [],
    features: Array.isArray(wallet.features) ? wallet.features : [],
  }
}

function normalizeStatusReactions(reactions = {}) {
  return {
    total: Number(reactions.total || 0),
    latestReaction: reactions.latestReaction || null,
    logs: Array.isArray(reactions.logs) ? reactions.logs.slice(0, MAX_REACTION_LOGS) : [],
  }
}

function normalizePairing(pairing = {}) {
  return {
    rawCode: String(pairing.rawCode || ''),
    code: String(pairing.code || ''),
    createdAt: pairing.createdAt || null,
    expiresAt: pairing.expiresAt || null,
  }
}

function syncSettingsWithRecord(record) {
  const defaults = getDefaultSettings(record.number)
  record.settings = { ...defaults, ...(record.settings || {}) }
  record.settings.ownerNumber = record.number
  record.settings.autoStatusRead = boolToOnOff(record.autoViewStatus !== false)
  record.settings.autoStatusReact = boolToOnOff(record.autoReactStatus !== false)
  record.settings.statusCustomReact = emojisText(record.reactionEmojis)
  record.emoji = emojisText(record.reactionEmojis)
  return record
}

function normalizeNumberRecord(record = {}) {
  const number = normalizeNumber(record.number)
  const reactionEmojis = normalizeReactionEmojis(record.reactionEmojis || record.emoji)
  const normalized = {
    number,
    linkedAt: Number(record.linkedAt || Date.now()),
    status: record.status || 'new',
    autoViewStatus: record.autoViewStatus !== false,
    autoReactStatus: record.autoReactStatus !== false,
    reactionEmojis,
    emoji: emojisText(reactionEmojis),
    settings: { ...getDefaultSettings(number), ...(record.settings || {}) },
    panelPasswordHash: record.panelPasswordHash || '',
    panelTokens: Array.isArray(record.panelTokens) ? record.panelTokens : [],
    wallet: normalizeWallet(record.wallet),
    statusReactions: normalizeStatusReactions(record.statusReactions),
    pairing: normalizePairing(record.pairing),
    lastSeenAt: record.lastSeenAt || null,
    lastConnectedAt: record.lastConnectedAt || null,
    lastReconnectAt: record.lastReconnectAt || null,
    note: record.note || '',
  }
  return syncSettingsWithRecord(normalized)
}

function normalizeUserRecord(userId, user = {}) {
  const id = normalizeUserId(user.userId || userId)
  const numbers = Array.isArray(user.numbers)
    ? user.numbers.map((item) => normalizeNumberRecord(item)).filter((item) => item.number)
    : []
  return {
    userId: id,
    chatId: user.chatId || null,
    dashboardMessageId: Number(user.dashboardMessageId || 0) || null,
    numbers,
  }
}

function touch() {
  data.lastUpdatedAt = nowIso()
}

function load() {
  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (e) {
    console.error('⚠️ خطأ في قراءة قاعدة البيانات:', e.message)
    data = { users: {}, comments: [], metrics: {}, lastUpdatedAt: nowIso() }
  }

  if (!data || typeof data !== 'object') data = {}
  if (!data.users || typeof data.users !== 'object') data.users = {}
  if (!Array.isArray(data.comments)) data.comments = []
  data.comments = data.comments.slice(0, MAX_COMMENTS)
  data.metrics = {
    totalStatusReactions: 0,
    totalStatusViews: 0,
    totalPairingCodesIssued: 0,
    totalSuccessfulLinks: 0,
    totalReconnects: 0,
    totalSelfMessages: 0,
    totalBroadcastsTelegram: 0,
    totalBroadcastsWhatsapp: 0,
    totalBroadcastRecipientsTelegram: 0,
    totalBroadcastRecipientsWhatsapp: 0,
    ...(data.metrics || {}),
  }

  const normalizedUsers = {}
  for (const [userId, user] of Object.entries(data.users)) {
    const normalized = normalizeUserRecord(userId, user)
    normalizedUsers[normalized.userId] = normalized
  }
  data.users = normalizedUsers
  touch()
  save()
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  } catch (e) {
    console.error('⚠️ خطأ في حفظ قاعدة البيانات:', e.message)
  }
}

function ensureUser(userId, chatId = null) {
  const id = normalizeUserId(userId)
  if (!id) throw new Error('invalid_user')
  if (!data.users[id]) {
    data.users[id] = normalizeUserRecord(id, { userId: id, chatId, numbers: [] })
    touch()
    save()
  } else if (chatId && data.users[id].chatId !== chatId) {
    data.users[id].chatId = chatId
    touch()
    save()
  }
  return data.users[id]
}

function getUser(userId) {
  return data.users[normalizeUserId(userId)] || null
}

function getUserByChatId(chatId) {
  for (const user of Object.values(data.users)) {
    if (user.chatId === chatId) return user
  }
  return null
}

function setDashboardMessage(userId, messageId) {
  const user = ensureUser(userId)
  user.dashboardMessageId = Number(messageId || 0) || null
  touch()
  save()
  return user.dashboardMessageId
}

function getDashboardMessage(userId) {
  return getUser(userId)?.dashboardMessageId || null
}

function clearDashboardMessage(userId) {
  const user = getUser(userId)
  if (!user) return
  user.dashboardMessageId = null
  touch()
  save()
}

function numberOwner(number) {
  const normalized = normalizeNumber(number)
  for (const user of Object.values(data.users)) {
    const found = (user.numbers || []).find((item) => item.number === normalized)
    if (found) return user.userId
  }
  return null
}

function getNumber(userId, number) {
  const normalized = normalizeNumber(number)
  const user = getUser(userId)
  if (!user) return null
  return (user.numbers || []).find((item) => item.number === normalized) || null
}

function getNumberWithOwner(number) {
  const normalized = normalizeNumber(number)
  for (const user of Object.values(data.users)) {
    const record = (user.numbers || []).find((item) => item.number === normalized)
    if (record) return { userId: user.userId, user, record }
  }
  return null
}

function addNumber(userId, number, chatId = null) {
  const id = normalizeUserId(userId)
  const normalized = normalizeNumber(number)
  if (!/^\d{8,15}$/.test(normalized)) throw new Error('invalid_number')
  const user = ensureUser(id, chatId)

  if ((user.numbers || []).some((item) => item.number === normalized)) {
    throw new Error('already_linked')
  }

  const owner = numberOwner(normalized)
  if (owner !== null && owner !== id) {
    throw new Error('linked_other')
  }

  const record = normalizeNumberRecord({
    number: normalized,
    linkedAt: Date.now(),
    status: 'new',
    reactionEmojis: DEFAULT_EMOJIS,
  })
  user.numbers.push(record)
  touch()
  save()
  return record
}

function removeNumber(userId, number) {
  const normalized = normalizeNumber(number)
  const user = getUser(userId)
  if (!user) return false
  const before = (user.numbers || []).length
  user.numbers = (user.numbers || []).filter((item) => item.number !== normalized)
  if (user.numbers.length !== before) {
    touch()
    save()
    return true
  }
  return false
}

function getAllNumbers() {
  const out = []
  for (const user of Object.values(data.users)) {
    for (const record of user.numbers || []) {
      out.push({ userId: user.userId, chatId: user.chatId, ...clone(record) })
    }
  }
  return out
}

function setStatus(userId, number, status) {
  const record = getNumber(userId, number)
  if (!record) return null
  record.status = status || 'new'
  if (status === 'connected') record.lastConnectedAt = nowIso()
  if (status === 'connecting') record.lastReconnectAt = nowIso()
  touch()
  save()
  return record
}

function setReactionEmojis(userId, number, emojis) {
  const record = getNumber(userId, number)
  if (!record) throw new Error('not_found')
  record.reactionEmojis = normalizeReactionEmojis(emojis)
  syncSettingsWithRecord(record)
  touch()
  save()
  return record
}

function setReactionEmojisByNumber(number, emojis) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  return setReactionEmojis(found.userId, found.record.number, emojis)
}

function getReactionEmojis(userId, number) {
  const record = getNumber(userId, number)
  return record ? normalizeReactionEmojis(record.reactionEmojis) : [...DEFAULT_EMOJIS]
}

function getReactionEmojiText(userId, number) {
  return emojisText(getReactionEmojis(userId, number))
}

function setEmoji(userId, number, emojiOrEmojis) {
  return setReactionEmojis(userId, number, emojiOrEmojis)
}

function getEmoji(userId, number) {
  return getReactionEmojiText(userId, number)
}

function hashPassword(number, password) {
  return crypto
    .createHash('sha256')
    .update(`${config.PASSWORD_SECRET}|${normalizeNumber(number)}|${String(password || '')}`)
    .digest('hex')
}

function getDefaultPassword(number) {
  return normalizeNumber(number)
}

function verifyPanelPassword(number, password) {
  const found = getNumberWithOwner(number)
  if (!found) return false
  const fallback = getDefaultPassword(number)
  const expectedHash = found.record.panelPasswordHash || hashPassword(number, fallback)
  return expectedHash === hashPassword(number, password)
}

function hasCustomPassword(number) {
  const found = getNumberWithOwner(number)
  return !!found?.record?.panelPasswordHash
}

function setPanelPassword(number, password) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  found.record.panelPasswordHash = hashPassword(number, password)
  touch()
  save()
  return true
}

function buildTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function purgeExpiredPanelTokens(record) {
  record.panelTokens = (record.panelTokens || []).filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now())
}

function issuePanelToken(number, ttlDays = config.PANEL_TOKEN_TTL_DAYS) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  const token = crypto.randomBytes(PANEL_TOKEN_BYTES).toString('hex')
  const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlDays || 30)) * ONE_DAY_MS).toISOString()
  purgeExpiredPanelTokens(found.record)
  found.record.panelTokens.push({
    hash: buildTokenHash(token),
    createdAt: nowIso(),
    expiresAt,
  })
  touch()
  save()
  return { token, expiresAt }
}

function verifyPanelToken(number, token) {
  const found = getNumberWithOwner(number)
  if (!found || !token) return false
  purgeExpiredPanelTokens(found.record)
  const hash = buildTokenHash(token)
  const ok = (found.record.panelTokens || []).some((item) => item.hash === hash)
  if (ok) {
    touch()
    save()
  }
  return ok
}

function findNumberByPanelToken(token) {
  if (!token) return null
  const hash = buildTokenHash(token)
  for (const user of Object.values(data.users)) {
    for (const record of user.numbers || []) {
      purgeExpiredPanelTokens(record)
      if ((record.panelTokens || []).some((item) => item.hash === hash)) {
        touch()
        save()
        return { userId: user.userId, user, record }
      }
    }
  }
  return null
}

function revokePanelToken(number, token) {
  const found = getNumberWithOwner(number)
  if (!found || !token) return false
  const hash = buildTokenHash(token)
  const before = (found.record.panelTokens || []).length
  found.record.panelTokens = (found.record.panelTokens || []).filter((item) => item.hash !== hash)
  if (found.record.panelTokens.length !== before) {
    touch()
    save()
    return true
  }
  return false
}

function revokePanelTokenByToken(token) {
  const found = findNumberByPanelToken(token)
  if (!found) return false
  return revokePanelToken(found.record.number, token)
}

function getSettingsByNumber(number) {
  const found = getNumberWithOwner(number)
  if (!found) return null
  return clone(syncSettingsWithRecord(found.record).settings)
}

function setSettingsByNumber(number, patch = {}) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  found.record.settings = { ...getDefaultSettings(found.record.number), ...(found.record.settings || {}), ...(patch || {}) }
  found.record.autoViewStatus = onOffToBool(found.record.settings.autoStatusRead, found.record.autoViewStatus !== false)
  found.record.autoReactStatus = onOffToBool(found.record.settings.autoStatusReact, found.record.autoReactStatus !== false)
  found.record.reactionEmojis = normalizeReactionEmojis(found.record.settings.statusCustomReact)
  syncSettingsWithRecord(found.record)
  touch()
  save()
  return clone(found.record.settings)
}

function setPairingCode(number, rawCode, code, expiresInSeconds = config.PAIRING_CODE_TTL_SECONDS) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + Math.max(15, Number(expiresInSeconds || 60)) * 1000).toISOString()
  found.record.pairing = { rawCode: String(rawCode || ''), code: String(code || ''), createdAt, expiresAt }
  bumpMetric('totalPairingCodesIssued', 1)
  save()
  return clone(found.record.pairing)
}

function getPairingCode(number) {
  const found = getNumberWithOwner(number)
  if (!found) return null
  const pairing = found.record.pairing || null
  if (!pairing?.expiresAt) return pairing
  if (new Date(pairing.expiresAt).getTime() <= Date.now()) return null
  return clone(pairing)
}

function clearPairingCode(number) {
  const found = getNumberWithOwner(number)
  if (!found) return false
  found.record.pairing = normalizePairing()
  touch()
  save()
  return true
}

function bumpMetric(name, amount = 1) {
  data.metrics[name] = Number(data.metrics[name] || 0) + Number(amount || 0)
  touch()
  return data.metrics[name]
}

function addStatusReaction(number, payload = {}) {
  const found = getNumberWithOwner(number)
  if (!found) return null
  const entry = {
    emoji: payload.emoji || '❤️',
    participantNumber: payload.participantNumber || '',
    participantLabel: payload.participantLabel || payload.participantNumber || '',
    reactedAt: payload.reactedAt || nowIso(),
    source: payload.source || 'status',
  }
  const target = found.record.statusReactions
  target.total = Number(target.total || 0) + 1
  target.latestReaction = entry
  target.logs = [entry, ...(target.logs || [])].slice(0, MAX_REACTION_LOGS)
  bumpMetric('totalStatusReactions', 1)
  save()
  return clone(target)
}

function bumpStatusView(number) {
  const found = getNumberWithOwner(number)
  if (!found) return 0
  found.record.lastSeenAt = nowIso()
  bumpMetric('totalStatusViews', 1)
  save()
  return data.metrics.totalStatusViews
}

function getStatusReactions(number) {
  const found = getNumberWithOwner(number)
  if (!found) return { total: 0, latestReaction: null, logs: [], indicator: 'idle' }
  const target = normalizeStatusReactions(found.record.statusReactions)
  const latestAt = target.latestReaction?.reactedAt ? new Date(target.latestReaction.reactedAt).getTime() : 0
  const indicator = latestAt && Date.now() - latestAt <= 5 * 60 * 1000 ? 'active' : 'idle'
  return { ...clone(target), indicator }
}

function addComment({ name, contact, message }) {
  const item = {
    id: crypto.randomUUID(),
    name: String(name || 'زائر').trim() || 'زائر',
    contact: String(contact || '').trim(),
    message: String(message || '').trim(),
    createdAt: nowIso(),
    reply: null,
  }
  data.comments = [item, ...data.comments].slice(0, MAX_COMMENTS)
  touch()
  save()
  return clone(item)
}

function listComments() {
  return clone(data.comments || [])
}

function replyComment(commentId, replyText, by = 'المطور') {
  const item = (data.comments || []).find((comment) => comment.id === commentId)
  if (!item) throw new Error('not_found')
  item.reply = {
    text: String(replyText || '').trim(),
    by: String(by || 'المطور').trim() || 'المطور',
    createdAt: nowIso(),
  }
  touch()
  save()
  return clone(item)
}

function getStoreOffers(number) {
  const wallet = getWallet(number)
  const now = Date.now()
  return STORE_OFFERS.map((offer) => {
    const activeFeature = (wallet.activeFeatures || []).find((item) => item.key === offer.key && new Date(item.activeUntil).getTime() > now)
    return {
      ...offer,
      active: !!activeFeature,
      activeUntil: activeFeature?.activeUntil || null,
    }
  })
}

function getWallet(number) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  const wallet = normalizeWallet(found.record.wallet)
  const now = Date.now()
  wallet.features = (wallet.features || []).filter((item) => !item.activeUntil || new Date(item.activeUntil).getTime() > now)
  found.record.wallet = wallet
  const nextClaimAt = wallet.lastDailyClaimAt ? wallet.lastDailyClaimAt + ONE_DAY_MS : 0
  const remainingMs = nextClaimAt > now ? nextClaimAt - now : 0
  const activeFeatures = wallet.features.map((item) => ({
    key: item.key,
    title: item.title,
    activeUntil: item.activeUntil,
  }))
  save()
  return {
    balance: wallet.balance,
    totalClaimed: wallet.totalClaimed,
    totalSpent: wallet.totalSpent,
    dailyAmount: config.DAILY_COIN_AMOUNT,
    canClaimDaily: remainingMs <= 0,
    remainingMs,
    tier: activeFeatures.some((item) => item.key.startsWith('vip')) ? 'VIP' : 'STANDARD',
    activeFeatures,
    transactions: wallet.transactions.slice(0, 60),
  }
}

function pushWalletTx(wallet, tx) {
  wallet.transactions = [tx, ...(wallet.transactions || [])].slice(0, 120)
}

function claimDaily(number) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  const wallet = normalizeWallet(found.record.wallet)
  const now = Date.now()
  const nextClaimAt = wallet.lastDailyClaimAt ? wallet.lastDailyClaimAt + ONE_DAY_MS : 0
  if (nextClaimAt > now) {
    const error = new Error('too_early')
    error.remainingMs = nextClaimAt - now
    throw error
  }
  wallet.balance += config.DAILY_COIN_AMOUNT
  wallet.totalClaimed += config.DAILY_COIN_AMOUNT
  wallet.lastDailyClaimAt = now
  pushWalletTx(wallet, {
    type: 'daily_claim',
    amount: config.DAILY_COIN_AMOUNT,
    createdAt: nowIso(),
    title: 'المكافأة اليومية',
  })
  found.record.wallet = wallet
  touch()
  save()
  return { amount: config.DAILY_COIN_AMOUNT, wallet: getWallet(number) }
}

function buyOffer(number, offerKey) {
  const found = getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  const offer = STORE_OFFERS.find((item) => item.key === offerKey)
  if (!offer) throw new Error('offer_not_found')
  const wallet = normalizeWallet(found.record.wallet)
  if (wallet.balance < offer.price) throw new Error('insufficient_balance')
  wallet.balance -= offer.price
  wallet.totalSpent += offer.price
  const activeUntil = new Date(Date.now() + offer.durationDays * ONE_DAY_MS).toISOString()
  wallet.features = (wallet.features || []).filter((item) => item.key !== offer.key)
  wallet.features.push({ key: offer.key, title: offer.title, activeUntil })
  pushWalletTx(wallet, {
    type: 'purchase',
    amount: -offer.price,
    createdAt: nowIso(),
    title: offer.title,
  })
  found.record.wallet = wallet
  touch()
  save()
  return { offer: { ...offer, activeUntil }, wallet: getWallet(number) }
}

function buildPublicConfig(runtime = {}) {
  return {
    siteTitle: config.SITE_TITLE,
    siteDescription: config.SITE_DESCRIPTION,
    whatsappChannelUrl: config.WHATSAPP_CHANNEL_URL,
    developerWhatsappUrl: config.DEVELOPER_WHATSAPP_URL,
    ownerPanelUrl: config.OWNER_PANEL_URL,
    aiPageUrl: config.AI_PAGE_URL,
    dailyCoinAmount: config.DAILY_COIN_AMOUNT,
    databaseInfo: {
      mongoEnabled: false,
      sessionStorageMode: 'multi-file-auth + json',
      autoReconnect: true,
      sessionPersistence: true,
      statusAutomation: true,
      automaticIndexes: false,
      totalUsers: Object.keys(data.users || {}).length,
      totalNumbers: getAllNumbers().length,
      activeSessions: Number(runtime.activeSessions || 0),
    },
  }
}

function buildPublicStats(runtime = {}) {
  const all = getAllNumbers()
  const comments = listComments()
  const totalUsers = Object.keys(data.users || {}).length
  const connected = all.filter((item) => item.status === 'connected').length
  const pairing = all.filter((item) => item.status === 'pairing').length
  const connecting = all.filter((item) => item.status === 'connecting').length
  const loggedOut = all.filter((item) => item.status === 'logged_out').length
  const channelJoined = all.length
  const repliedComments = comments.filter((item) => item.reply).length
  const totalNumbers = all.length
  const connectedRate = totalNumbers ? Math.round((connected / totalNumbers) * 100) : 0
  const channelJoinRate = totalNumbers ? 100 : 0
  const repliedRate = comments.length ? Math.round((repliedComments / comments.length) * 100) : 100

  return {
    totalUsers,
    totalNumbers,
    connected,
    pairing,
    connecting,
    loggedOut,
    channelJoined,
    connectedRate,
    channelJoinRate,
    comments: {
      totalComments: comments.length,
      repliedComments,
      pendingReplies: comments.length - repliedComments,
    },
    health: {
      pendingComments: comments.length - repliedComments,
      repliedRate,
    },
    metrics: clone(data.metrics),
    runtime: {
      activeSessions: Number(runtime.activeSessions || 0),
      startedAt: runtime.startedAt || nowIso(),
      uptimeMs: Number(runtime.uptimeMs || 0),
      siteUrl: config.BASE_URL,
    },
    lastUpdatedAt: data.lastUpdatedAt || nowIso(),
  }
}

module.exports = {
  DEFAULT_EMOJIS,
  load,
  save,
  ensureUser,
  getUser,
  getUserByChatId,
  setDashboardMessage,
  getDashboardMessage,
  clearDashboardMessage,
  numberOwner,
  addNumber,
  getNumber,
  getNumberWithOwner,
  removeNumber,
  getAllNumbers,
  setStatus,
  setEmoji,
  getEmoji,
  setReactionEmojis,
  setReactionEmojisByNumber,
  getReactionEmojis,
  getReactionEmojiText,
  getDefaultPassword,
  verifyPanelPassword,
  hasCustomPassword,
  setPanelPassword,
  issuePanelToken,
  verifyPanelToken,
  findNumberByPanelToken,
  revokePanelToken,
  revokePanelTokenByToken,
  getSettingsByNumber,
  setSettingsByNumber,
  setPairingCode,
  getPairingCode,
  clearPairingCode,
  bumpMetric,
  addStatusReaction,
  bumpStatusView,
  getStatusReactions,
  addComment,
  listComments,
  replyComment,
  getWallet,
  getStoreOffers,
  claimDaily,
  buyOffer,
  buildPublicConfig,
  buildPublicStats,
  normalizeNumber,
  normalizeReactionEmojis,
  emojisText,
}