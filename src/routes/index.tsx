import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';

type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
type InterpreterStatus = 'active' | 'handoff' | 'standby' | 'offline';
type DutyStatus = 'on-duty' | 'handoff' | 'offline-pending' | 'queued' | 'standby';
type CaptionStatus = 'confirmed' | 'pending';
type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
type Speech = { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string };
type Channel = { id: string; roomId: string; language: string; health: number };
type DutyRecord = { id: string; interpreter: string; roomId: string; channelId: string | null; status: DutyStatus; queuedAt: string };
type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
type Caption = { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; status: CaptionStatus; at: string };
type Audit = { id: string; at: string; roomId: string; message: string };

interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  dutyRoster: DutyRecord[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
}

const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', health: 94 }
  ],
  dutyRoster: [
    { id: 'duty-1', interpreter: '周雨', roomId: 'hall-a', channelId: 'ch-a-zh', status: 'on-duty', queuedAt: now },
    { id: 'duty-2', interpreter: 'Lucía M.', roomId: 'hall-a', channelId: 'ch-a-es', status: 'on-duty', queuedAt: now },
    { id: 'duty-3', interpreter: '何佳', roomId: 'hall-b', channelId: 'ch-b-zh', status: 'on-duty', queuedAt: now },
    { id: 'duty-4', interpreter: 'Noah B.', roomId: 'hall-a', channelId: 'ch-a-fr', status: 'standby', queuedAt: now }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, status: 'confirmed', at: now }
  ],
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const STORAGE_KEY = 'conference-interpretation-v2';

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ConferenceState;
    const legacy = localStorage.getItem('conference-interpretation-v1');
    if (legacy) {
      const parsed = JSON.parse(legacy) as Partial<ConferenceState>;
      return { ...seed, ...parsed, dutyRoster: parsed.dutyRoster ?? seed.dutyRoster };
    }
    return seed;
  } catch { return seed; }
}

// ---- 在岗记录（全局唯一）----
// 一位译员同一时刻只在一个厅值班；on-duty / handoff / offline-pending 都占着名额，
// queued 只排队不占位，standby 待命不占位。
const OCCUPYING: DutyStatus[] = ['on-duty', 'handoff', 'offline-pending'];
const DUTY_LABEL: Record<DutyStatus, string> = {
  'on-duty': '在岗',
  handoff: '交接中',
  'offline-pending': '离线待确认',
  queued: '排队候补中',
  standby: '待命'
};

function dutyOf(state: ConferenceState, interpreter: string) {
  return state.dutyRoster.find((r) => r.interpreter === interpreter);
}
function dutyOfChannel(state: ConferenceState, channelId: string) {
  return state.dutyRoster.find((r) => r.channelId === channelId && r.status !== 'queued');
}
function hallOccupied(state: ConferenceState, roomId: string) {
  return state.dutyRoster.filter((r) => r.roomId === roomId && OCCUPYING.includes(r.status)).length;
}
function hallQueue(state: ConferenceState, roomId: string) {
  return state.dutyRoster
    .filter((r) => r.roomId === roomId && r.status === 'queued')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}
function audit(state: ConferenceState, roomId: string, message: string) {
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message });
}

// 频道当前译员与状态（由全局在岗记录派生，频道本身不再存名字）
function channelDuty(state: ConferenceState, channel: Channel) {
  const duty = dutyOfChannel(state, channel.id);
  return {
    interpreter: duty?.interpreter ?? '（空）',
    status: (duty?.status === 'on-duty' ? 'active'
      : duty?.status === 'handoff' ? 'handoff'
      : duty?.status === 'offline-pending' ? 'offline'
      : 'standby') as InterpreterStatus
  };
}

// 空出名额后按先后补位：只补“已空闲”的译员，交接/离线没走完的继续等。
function promoteQueue(state: ConferenceState, roomId: string) {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return;
  let guard = 0;
  while (guard++ < 64) {
    if (hallOccupied(state, roomId) >= room.simultaneousChannels) break;
    const next = hallQueue(state, roomId)[0];
    if (!next) break;
    const stillBusy = state.dutyRoster.some(
      (r) => r.interpreter === next.interpreter && r.roomId !== roomId && OCCUPYING.includes(r.status)
    );
    if (stillBusy) break; // 对方交接/离线没走完，名额还没释放，不能补
    const channel = state.channels.find((c) => c.roomId === roomId && !dutyOfChannel(state, c.id));
    next.status = 'on-duty';
    next.channelId = channel?.id ?? null;
    audit(state, roomId, `补位完成：${next.interpreter} 已上岗${channel ? `（${channel.language}频道）` : ''}，队列顺延`);
  }
}

// 补位：幂等。已在本厅占位则直接返回；在别厅值班则启动交接并去本厅排队；
// 本厅容量满则排队；空闲才真正占位。重试不会重复占位。
function fillSlot(
  state: ConferenceState,
  interpreter: string,
  roomId: string,
  channelId?: string
): { ok: boolean; status: DutyStatus; idempotent?: boolean; reason?: string } {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, status: 'queued', reason: 'no-room' };
  const existing = dutyOf(state, interpreter);

  if (existing && existing.roomId === roomId && OCCUPYING.includes(existing.status)) {
    return { ok: true, status: existing.status, idempotent: true }; // 已在本厅占位，重试不重复占
  }
  if (existing && existing.roomId === roomId && existing.status === 'queued') {
    return { ok: false, status: 'queued', idempotent: true, reason: 'queued' }; // 已在队列中，保持原位
  }
  if (existing && OCCUPYING.includes(existing.status) && existing.roomId !== roomId) {
    if (existing.status === 'on-duty') existing.status = 'handoff'; // 交接没走完，仍占着原厅名额
    if (!state.dutyRoster.some((r) => r.interpreter === interpreter && r.roomId === roomId && r.status === 'queued')) {
      state.dutyRoster.push({ id: crypto.randomUUID(), interpreter, roomId, channelId: null, status: 'queued', queuedAt: new Date().toISOString() });
    }
    audit(state, roomId, `${interpreter} 仍在 ${state.rooms.find((r) => r.id === existing.roomId)?.name} 值班，交接未完成不占新厅名额，已进入候补队列`);
    return { ok: false, status: 'queued', reason: 'handoff-pending' };
  }

  const occupied = hallOccupied(state, roomId);
  if (occupied >= room.simultaneousChannels) {
    if (existing && existing.status === 'standby') {
      existing.roomId = roomId;
      existing.channelId = null;
      existing.status = 'queued';
    } else if (!existing) {
      state.dutyRoster.push({ id: crypto.randomUUID(), interpreter, roomId, channelId: null, status: 'queued', queuedAt: new Date().toISOString() });
    }
    audit(state, roomId, `${interpreter} 补位时容量已满（${occupied}/${room.simultaneousChannels}），已排队，空出后按先后补位`);
    return { ok: false, status: 'queued', reason: 'capacity-full' };
  }

  const channel = channelId
    ? state.channels.find((c) => c.id === channelId)
    : state.channels.find((c) => c.roomId === roomId && !dutyOfChannel(state, c.id));
  if (existing) {
    existing.roomId = roomId;
    existing.channelId = channel?.id ?? null;
    existing.status = 'on-duty';
  } else {
    state.dutyRoster.push({ id: crypto.randomUUID(), interpreter, roomId, channelId: channel?.id ?? null, status: 'on-duty', queuedAt: new Date().toISOString() });
  }
  audit(state, roomId, `${interpreter} 已在 ${room.name} 上岗${channel ? `（${channel.language}频道）` : ''}`);
  return { ok: true, status: 'on-duty' };
}

function retryFill(state: ConferenceState, interpreter: string, roomId: string) {
  const existing = dutyOf(state, interpreter);
  if (existing && existing.roomId === roomId && OCCUPYING.includes(existing.status)) return; // 已占位，重试幂等
  fillSlot(state, interpreter, roomId);
  promoteQueue(state, roomId);
}

function requestTransfer(state: ConferenceState, interpreter: string, roomId: string) {
  fillSlot(state, interpreter, roomId);
}

function startHandoff(state: ConferenceState, channelId: string) {
  const channel = state.channels.find((c) => c.id === channelId);
  const duty = dutyOfChannel(state, channelId);
  if (!channel || !duty || duty.status !== 'on-duty') return;
  duty.status = 'handoff';
  audit(state, channel.roomId, `${duty.interpreter} 启动交接，${channel.language}频道名额仍占用，期间新字幕暂存待确认`);
}

function completeHandoff(state: ConferenceState, channelId: string, newInterpreter: string) {
  const channel = state.channels.find((c) => c.id === channelId);
  if (!channel || !newInterpreter.trim()) return;
  const old = dutyOfChannel(state, channelId);
  if (old && old.status === 'handoff') {
    state.dutyRoster = state.dutyRoster.filter((r) => r.id !== old.id);
    audit(state, channel.roomId, `交接完成：${old.interpreter} 离开 ${channel.language}频道，名额释放`);
  }
  fillSlot(state, newInterpreter.trim(), channel.roomId, channelId);
  promoteQueue(state, channel.roomId);
}

function goOffline(state: ConferenceState, channelId: string) {
  const channel = state.channels.find((c) => c.id === channelId);
  const duty = dutyOfChannel(state, channelId);
  if (!channel || !duty || duty.status !== 'on-duty') return;
  duty.status = 'offline-pending';
  audit(state, channel.roomId, `${duty.interpreter} 已掉线，等待确认离线；名额暂不释放，期间新字幕暂存待确认`);
}

function confirmOffline(state: ConferenceState, channelId: string) {
  const channel = state.channels.find((c) => c.id === channelId);
  const duty = dutyOfChannel(state, channelId);
  if (!channel || !duty || duty.status !== 'offline-pending') return;
  state.dutyRoster = state.dutyRoster.filter((r) => r.id !== duty.id);
  audit(state, channel.roomId, `已确认 ${duty.interpreter} 离线，${channel.language}频道名额释放`);
  promoteQueue(state, channel.roomId);
}

// 字幕：交接/离线/空频道期间产出的字幕先留“待确认”，不锁定归属；确认后才归到当前译员。
function addCaption(state: ConferenceState, speechId: string, text: string) {
  const speech = state.speechQueue.find((s) => s.id === speechId);
  if (!speech || !text.trim()) return;
  const channel = state.channels.find((c) => c.roomId === speech.roomId && c.language === '中文');
  if (!channel) return;
  const duty = dutyOfChannel(state, channel.id);
  const pending = !duty || duty.status === 'handoff' || duty.status === 'offline-pending';
  const existing = state.captions.find((c) => c.speechId === speechId && c.language === channel.language);
  const at = new Date().toISOString();
  if (existing) {
    state.captions = state.captions.map((c) => c.id === existing.id
      ? { ...c, text, revision: c.revision + 1, status: pending ? 'pending' : c.status, at }
      : c);
  } else {
    state.captions.unshift({
      id: crypto.randomUUID(),
      speechId,
      roomId: speech.roomId,
      language: channel.language,
      interpreter: pending ? '待确认' : duty.interpreter,
      text,
      revision: 1,
      status: pending ? 'pending' : 'confirmed',
      at
    });
  }
}

function confirmCaption(state: ConferenceState, captionId: string) {
  const cap = state.captions.find((c) => c.id === captionId);
  if (!cap || cap.status !== 'pending') return;
  const channel = state.channels.find((c) => c.roomId === cap.roomId && c.language === cap.language);
  const duty = channel ? dutyOfChannel(state, channel.id) : null;
  state.captions = state.captions.map((c) => c.id === captionId
    ? { ...c, status: 'confirmed', interpreter: duty?.interpreter ?? c.interpreter, at: new Date().toISOString() }
    : c);
  audit(state, cap.roomId, `字幕已确认（${cap.language}），归属 ${duty?.interpreter ?? '当前译员'}`);
}

const advanceSpeech$ = $((state: ConferenceState, id: string, status: SpeechStatus) => {
  state.speechQueue = state.speechQueue.map((item) => item.id === id ? { ...item, status, updatedAt: new Date().toISOString() } : item);
  if (status === 'speaking') {
    state.speechQueue = state.speechQueue.map((item) => item.id !== id && item.roomId === state.activeRoomId && item.status === 'speaking' ? { ...item, status: 'done' } : item);
  }
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `发言 ${id} 状态更新为 ${status}` });
});

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });
  const handoffDrafts = useSignal<Record<string, string>>({});
  const transferPick = useSignal('');

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const roomOccupied = () => hallOccupied(state, state.activeRoomId);
  const roomQueued = () => hallQueue(state, state.activeRoomId);
  const currentChannel = () => state.channels.find((c) => c.roomId === state.activeRoomId && c.language === '中文');
  const currentChannelDuty = () => {
    const channel = currentChannel();
    return channel ? channelDuty(state, channel) : null;
  };

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}` });
  });

  const addSpeech$ = $((values: QueueForm) => {
    state.speechQueue.push({ id: crypto.randomUUID(), roomId: state.activeRoomId, ...values, remainingSeconds: values.plannedSeconds, status: 'queued', updatedAt: new Date().toISOString() });
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${values.speaker} 已加入发言队列` });
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    const queryClient = new QueryClient();
    const confirmed = await queryClient.fetchQuery({
      queryKey: ['caption-publish', speech.id, values.text],
      queryFn: async () => values.text === values.text.trim(),
      staleTime: 0
    });
    if (confirmed) addCaption(state, speech.id, values.text);
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => term.id === id ? { ...term, approved: true } : term);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}` });
  });

  const requestTransfer$ = $(() => {
    const name = transferPick.value.trim();
    if (!name) return;
    requestTransfer(state, name, state.activeRoomId);
    transferPick.value = '';
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>发言队列</h2><span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span></div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(state, speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(state, speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button></>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(state, speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>频道与译员</h2><span class="pill">在岗 {roomOccupied()}/{activeRoom().simultaneousChannels} · 候补 {roomQueued().length}</span></div>
          {roomChannels().map((channel) => {
            const duty = channelDuty(state, channel);
            const draft = handoffDrafts.value[channel.id] ?? '';
            return (
              <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
                <div style="display:flex;justify-content:space-between"><b>{channel.language} · {duty.interpreter}</b><span class="pill">{duty.status}</span></div>
                <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  {duty.status === 'active' && <button class="secondary" onClick$={() => startHandoff(state, channel.id)}>开始交接</button>}
                  {duty.status === 'handoff' && (<>
                    <input style="width:150px" value={draft} onInput$={(event) => handoffDrafts.value = { ...handoffDrafts.value, [channel.id]: (event.target as HTMLInputElement).value }} placeholder="接替译员" />
                    <button onClick$={() => { completeHandoff(state, channel.id, handoffDrafts.value[channel.id] ?? ''); handoffDrafts.value = { ...handoffDrafts.value, [channel.id]: '' }; }}>完成交接</button>
                  </>)}
                  {duty.status === 'active' && <button class="secondary" onClick$={() => goOffline(state, channel.id)}>掉线</button>}
                  {duty.status === 'offline' && <button class="danger" onClick$={() => confirmOffline(state, channel.id)}>确认离线并释放</button>}
                </div>
              </div>
            );
          })}
          <h3>实时字幕修正</h3>
          {currentChannelDuty() && (currentChannelDuty()!.status === 'handoff' || currentChannelDuty()!.status === 'offline') && (
            <p style="color:#a05a00;background:#fff4e0;padding:8px;border-radius:8px;font-size:13px">当前频道{currentChannelDuty()!.status === 'handoff' ? '交接未完成' : '已掉线待确认'}，新字幕将先留“待确认”，不会按名字错误归属。</p>
          )}
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaption$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField><button type="submit">提交新版字幕</button></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => (
            <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <b>{caption.interpreter} · v{caption.revision}</b>
                {caption.status === 'pending'
                  ? <span class="pill" style="background:#fff4e0;color:#a05a00">待确认</span>
                  : <span class="pill">已确认</span>}
              </div>
              <p>{caption.text}</p>
              {caption.status === 'pending' && <button class="secondary" onClick$={() => confirmCaption(state, caption.id)}>确认字幕并归属当前译员</button>}
            </div>
          ))}
        </aside>
      </section>

      <section class="panel" style="margin-top:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h2>在岗记录与补位队列（各厅共用）</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <select style="width:220px" value={transferPick.value} onChange$={(event) => transferPick.value = (event.target as HTMLSelectElement).value}>
              <option value="">{`从其他厅调译员到${activeRoom().name}…`}</option>
              {state.dutyRoster.filter((r) => r.roomId !== state.activeRoomId).map((r) => {
                const label = `${r.interpreter} · ${state.rooms.find((rm) => rm.id === r.roomId)?.name ?? ''}（${DUTY_LABEL[r.status]}）`;
                return <option value={r.interpreter} key={r.id}>{label}</option>;
              })}
            </select>
            <button onClick$={requestTransfer$}>申请调员补位</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0">
          {state.rooms.map((room) => {
            const occupied = hallOccupied(state, room.id);
            const queued = hallQueue(state, room.id).length;
            return (
              <div style="border:1px solid #d5e5e3;border-radius:12px;padding:12px" key={room.id}>
                <b>{room.name}</b>
                <div style="margin:8px 0"><Progress.Root value={occupied} max={room.simultaneousChannels} /></div>
                <div style="font-size:13px;color:#59747b">在岗 {occupied}/{room.simultaneousChannels} · 候补 {queued}</div>
              </div>
            );
          })}
        </div>
        {roomQueued().length > 0 && (
          <div style="margin:10px 0;padding:10px;background:#fff8ed;border-radius:10px">
            <b>本厅候补（按先后补位）：</b>
            {roomQueued().map((r, i) => (
              <div key={r.id} style="display:flex;justify-content:space-between;align-items:center;padding:6px 0">
                <span>#{i + 1} {r.interpreter} · {DUTY_LABEL[r.status]}{r.channelId ? `（${state.channels.find((c) => c.id === r.channelId)?.language}频道）` : ''}</span>
                <button class="secondary" onClick$={() => retryFill(state, r.interpreter, r.roomId)}>重试补位</button>
              </div>
            ))}
          </div>
        )}
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:10px">
          {state.dutyRoster.map((r) => (
            <div key={r.id} style="display:flex;justify-content:space-between;align-items:center;border:1px solid #e6efee;border-radius:10px;padding:8px 12px">
              <div><b>{r.interpreter}</b><div style="font-size:12px;color:#59747b">{state.rooms.find((rm) => rm.id === r.roomId)?.name}{r.channelId ? ` · ${state.channels.find((c) => c.id === r.channelId)?.language}频道` : ''}</div></div>
              <span class="pill">{DUTY_LABEL[r.status]}</span>
            </div>
          ))}
        </div>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
        <article class="panel">
          <h2>操作与交接时间线</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 10).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
