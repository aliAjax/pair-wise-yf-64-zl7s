// 各厅共用的在岗记录与补位规则：纯函数实现，便于独立验证不变量

export type DutyStatus = 'on-duty' | 'handing-over' | 'offline-pending';
export type CaptionStatus = 'confirmed' | 'pending';
export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';

export type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
export type Speech = { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string };
export type Channel = { id: string; roomId: string; language: string; health: number };
export type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
export type Caption = { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; status: CaptionStatus; at: string };
export type Audit = { id: string; at: string; roomId: string; message: string };
// 各厅共用一份在岗记录：releasedAt 为空的记录都算占着名额（含交接中、掉线待确认）
export type DutyRecord = { id: string; requestId: string; interpreter: string; roomId: string; channelId: string; status: DutyStatus; since: string; releasedAt: string | null };
// 补位排队请求：id 即幂等键，重试沿用同一个 id，不会重复占位
export type StandbyRequest = { id: string; interpreter: string; roomId: string; channelId: string; requestedAt: string; attempts: number; lastError: string | null };

export interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  dutyRoster: DutyRecord[];
  standbyQueue: StandbyRequest[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
}

export const dutyStatusLabel: Record<DutyStatus, string> = {
  'on-duty': '在岗',
  'handing-over': '交接中',
  'offline-pending': '掉线待确认'
};

export function activeDutyOf(state: ConferenceState, channelId: string): DutyRecord | undefined {
  return state.dutyRoster.find((record) => record.channelId === channelId && !record.releasedAt);
}

export function occupiedSeats(state: ConferenceState, roomId: string): number {
  return state.dutyRoster.filter((record) => record.roomId === roomId && !record.releasedAt).length;
}

export function roomNameOf(state: ConferenceState, roomId: string): string {
  return state.rooms.find((room) => room.id === roomId)?.name ?? roomId;
}

export function pushAudit(state: ConferenceState, roomId: string, message: string) {
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message });
}

// 补位成功后确认该频道积压的待确认字幕：只把 pending 翻成 confirmed，
// 重试时已经没有 pending，自然不会再多出字幕
export function confirmPendingCaptions(state: ConferenceState, roomId: string, language: string, interpreter: string) {
  const at = new Date().toISOString();
  state.captions = state.captions.map((caption) =>
    caption.status === 'pending' && caption.roomId === roomId && caption.language === language
      ? { ...caption, status: 'confirmed' as CaptionStatus, interpreter, at }
      : caption
  );
}

// 幂等补位：同一个 request.id 无论重试多少次，至多落位一次
export function fillRequest(state: ConferenceState, request: StandbyRequest): boolean {
  const channel = state.channels.find((item) => item.id === request.channelId);
  const room = state.rooms.find((item) => item.id === request.roomId);
  if (!channel || !room) {
    state.standbyQueue = state.standbyQueue.filter((item) => item.id !== request.id);
    return false;
  }
  // 已经凭这个请求占过位 → 只把队列清掉，绝不再占第二个名额
  if (state.dutyRoster.some((record) => record.requestId === request.id && !record.releasedAt)) {
    state.standbyQueue = state.standbyQueue.filter((item) => item.id !== request.id);
    return true;
  }
  const fail = (reason: string): boolean => {
    request.attempts += 1;
    request.lastError = reason;
    return false;
  };
  // 一位译员同一时刻只能在一个厅值班（跨厅共用这份记录）
  const busy = state.dutyRoster.find((record) => !record.releasedAt && record.interpreter === request.interpreter);
  if (busy) return fail(`正在${roomNameOf(state, busy.roomId)}值班，不能同时挂两个厅`);
  // 交接没走完 / 掉线未确认时，原记录仍占着频道名额
  if (activeDutyOf(state, request.channelId)) return fail('频道仍被占用，等交接完成或确认离线');
  if (occupiedSeats(state, request.roomId) >= room.simultaneousChannels) return fail('厅内同传容量已满，排队等空位');
  state.dutyRoster.push({
    id: crypto.randomUUID(),
    requestId: request.id,
    interpreter: request.interpreter,
    roomId: request.roomId,
    channelId: request.channelId,
    status: 'on-duty',
    since: new Date().toISOString(),
    releasedAt: null
  });
  state.standbyQueue = state.standbyQueue.filter((item) => item.id !== request.id);
  confirmPendingCaptions(state, request.roomId, channel.language, request.interpreter);
  pushAudit(state, request.roomId, `${request.interpreter} 补位 ${channel.language} 频道，该频道待确认字幕已归属新译员`);
  return true;
}

// 名额空出来后按申请先后补位
export function drainQueue(state: ConferenceState, roomId: string) {
  const waiting = state.standbyQueue
    .filter((request) => request.roomId === roomId)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  for (const request of waiting) fillRequest(state, request);
}

export function releaseDuty(state: ConferenceState, record: DutyRecord, message: string) {
  record.releasedAt = new Date().toISOString();
  pushAudit(state, record.roomId, message);
  drainQueue(state, record.roomId);
}

// 申请上岗 / 顶班：能落位就立即落位，否则按先后排队；带 requestId 即为重试
export function requestDuty(state: ConferenceState, input: { interpreter: string; roomId: string; channelId: string; requestId?: string }) {
  const interpreter = input.interpreter.trim();
  if (!interpreter) return;
  // 重试：队列里已有同一请求，直接再试一次补位，不重复入队
  const queued = input.requestId ? state.standbyQueue.find((request) => request.id === input.requestId) : undefined;
  if (queued) { fillRequest(state, queued); return; }
  // 同一译员同一频道已有排队请求 → 视为重试，不重复占位
  const duplicate = state.standbyQueue.find((request) => request.interpreter === interpreter && request.channelId === input.channelId);
  if (duplicate) { fillRequest(state, duplicate); return; }
  const busy = state.dutyRoster.find((record) => !record.releasedAt && record.interpreter === interpreter);
  if (busy) {
    pushAudit(state, input.roomId, `${interpreter} 仍在${roomNameOf(state, busy.roomId)}值班，不能同时挂两个厅，申请已拒绝`);
    return;
  }
  const request: StandbyRequest = {
    id: input.requestId ?? crypto.randomUUID(),
    interpreter,
    roomId: input.roomId,
    channelId: input.channelId,
    requestedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null
  };
  if (!fillRequest(state, request)) state.standbyQueue.push(request);
}

export function retryFill(state: ConferenceState, requestId: string) {
  const request = state.standbyQueue.find((item) => item.id === requestId);
  if (request) fillRequest(state, request);
}

// 交接开始：原译员仍占着名额，直到交接完成才释放
export function beginHandoff(state: ConferenceState, channelId: string) {
  const duty = activeDutyOf(state, channelId);
  if (!duty || duty.status !== 'on-duty') return;
  duty.status = 'handing-over';
  pushAudit(state, duty.roomId, `${duty.interpreter} 开始交接，名额仍占用，等交接完成再补位`);
}

// 交接完成：此刻才释放名额，并按排队先后补位
export function completeHandoff(state: ConferenceState, channelId: string) {
  const duty = activeDutyOf(state, channelId);
  if (!duty || duty.status !== 'handing-over') return;
  releaseDuty(state, duty, `${duty.interpreter} 交接完成，频道名额已释放`);
}

// 译员掉线：名额继续占着，期间新字幕先留在待确认
export function markDisconnected(state: ConferenceState, channelId: string) {
  const duty = activeDutyOf(state, channelId);
  if (!duty || duty.status === 'offline-pending') return;
  duty.status = 'offline-pending';
  pushAudit(state, duty.roomId, `${duty.interpreter} 掉线，名额保留待确认离线，期间新字幕进入待确认`);
}

// 确认离线后才真正释放名额
export function confirmOffline(state: ConferenceState, channelId: string) {
  const duty = activeDutyOf(state, channelId);
  if (!duty || duty.status !== 'offline-pending') return;
  releaseDuty(state, duty, `${duty.interpreter} 已确认离线，名额释放`);
}

// 字幕发布/修订：已确认字幕修订时归属不变；掉线待确认期间新字幕先留在待确认
export function upsertCaption(state: ConferenceState, speechId: string, text: string) {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  const channel = state.channels.find((item) => item.roomId === speech?.roomId && item.language === '中文');
  if (!speech || !channel || !text.trim()) return;
  const duty = activeDutyOf(state, channel.id);
  const stable = !!duty && duty.status !== 'offline-pending';
  const existing = state.captions.find((item) => item.speechId === speechId && item.language === channel.language);
  if (existing) {
    state.captions = state.captions.map((item) => {
      if (item.id !== existing.id) return item;
      if (stable && duty) {
        // 频道稳定：直接确认；待确认的归属当前译员，已确认的归属不变
        return { ...item, text, revision: item.revision + 1, at: new Date().toISOString(), status: 'confirmed' as CaptionStatus, interpreter: item.status === 'pending' ? duty.interpreter : item.interpreter };
      }
      // 掉线待确认或频道空缺：修订出的新文本同样先留在待确认
      return { ...item, text, revision: item.revision + 1, at: new Date().toISOString(), status: 'pending' as CaptionStatus };
    });
  } else {
    state.captions.unshift({
      id: crypto.randomUUID(),
      speechId,
      roomId: speech.roomId,
      language: channel.language,
      interpreter: stable && duty ? duty.interpreter : '',
      text,
      revision: 1,
      status: stable ? 'confirmed' as CaptionStatus : 'pending' as CaptionStatus,
      at: new Date().toISOString()
    });
  }
}
