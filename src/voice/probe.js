// `/관리자 음성수신확인` — 망고가 음성채널 소리를 **받을 수 있는지만** 확인하는 진단입니다.
//
// 왜 진단부터인가: 소리 녹음(30초 되돌리기)을 만들기 전에 확인해야 하는 것이 세 개인데,
// 셋 다 토큰 없이는 알 수 없습니다. 추측으로 코드를 넣으면 이 저장소에서 이미 두 번 난
// 사고(고정 주소 `@handle/live`, ffmpeg 183)를 세 번째로 반복하게 됩니다.
//
//   1. 봇의 귀를 `rejoin({ selfDeaf: false })` 로 열 수 있는가 (음악을 끊지 않고)
//   2. 패킷이 실제로 도착하는가
//   3. 도착한 패킷을 **복호화**할 수 있는가 (디스코드 DAVE 종단간 암호화)
//
// ⚠️ **소리를 어디에도 저장하지 않습니다.** 개수와 바이트만 셉니다.
// 그리고 **명령을 실행한 사람이 그 음성방에 있어야만** 동작합니다 —
// 아무도 없는 방에 봇만 들어가 듣는 것은 남의 대화를 제3자가 듣는 것이 되기 때문입니다.
//
// 이 파일은 진단 전용이라 따로 떼어 뒀습니다. 확인이 끝나면 지워도 다른 곳이 안 깨집니다.
import {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { userError } from '../user-error.js';
import { withShareButton } from '../share.js';

const DEFAULT_SEC = 15;
const MAX_SEC = 30;

/**
 * 커넥션 내부에서 진단에 쓸 값을 꺼냅니다.
 *
 * `state.networking.state` 는 @discordjs/voice 의 **내부 구조**입니다. 공개 API 가 아니라
 * 라이브러리 판이 바뀌면 없어질 수 있어, 없으면 조용히 `null` 로 두고 나머지만 보고합니다.
 * (진단값이 안 보이는 것과 진단이 죽는 것은 다릅니다)
 */
function peekNetworking(connection) {
  try {
    const state = connection?.state?.networking?.state ?? null;
    return {
      encryptionMode: state?.connectionData?.encryptionMode ?? null,
      dave: Boolean(state?.dave),
    };
  } catch {
    return { encryptionMode: null, dave: false };
  }
}

/**
 * 진단 때문에 들어왔다면 진단이 끝나면 나가야 합니다.
 *
 * `scheduleLeave()` 를 쓸 수 없습니다. 그건 **사람이 있으면 안 나가는** 규칙(3.3-1)이라
 * 음악에는 맞지만 진단에는 틀립니다 — 확인을 켠 사람이 그 방에 있으니 영원히 남습니다.
 * 그리고 `scheduleLeave()` 는 재생이 끝나는 경로에서만 불리므로, 재생 없이 들어온 이 경우엔
 * 아무도 불러주지 않습니다. 그대로 두면 봇이 음성방에 계속 앉아 있습니다.
 */
export function idleForProbe(audio) {
  if (audio.isPlaying || audio.queue.length > 0) return false;
  // 확인하는 15초 사이에 누가 읽어주기 채팅방에 글을 썼을 수도 있습니다. 그건 끊지 않습니다.
  return audio.ttsPlayer?.state?.status === AudioPlayerStatus.Idle;
}

/** 봇이 실제로 귀를 막고 있는지 — 디스코드가 알려주는 값입니다 (우리가 보낸 요청이 아니라). */
export function botDeafState(guild) {
  const voice = guild?.members?.me?.voice;
  if (!voice) return null;
  return { selfDeaf: Boolean(voice.selfDeaf), serverDeaf: Boolean(voice.deaf) };
}

/**
 * 수신 스트림을 잠깐 관찰합니다.
 *
 * 소리 기록 버퍼가 이미 같은 사람을 구독하고 있으면 새 구독을 만들지 않고 그 스트림에
 * 진단용 리스너만 붙입니다. 진단이 끝날 때는 우리가 붙인 리스너만 떼며, 기존 기록 버퍼가
 * 소유한 스트림은 절대로 닫지 않습니다.
 */
export function observeReceiverStream(receiver, userId, { onData, onError }) {
  const existing = receiver.subscriptions.get(userId);
  const stream = existing ?? receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
  const owned = !existing;

  stream.on('data', onData);
  stream.on('error', onError);

  return {
    owned,
    stop() {
      stream.off('data', onData);
      stream.off('error', onError);
      if (!owned) return;
      try {
        stream.destroy();
      } catch {
        // 이미 닫힌 진단용 스트림입니다.
      }
    },
  };
}

/**
 * 실제 수신 확인. 세는 것만 하고 오디오는 버립니다.
 *
 * @returns 사람별 집계와 커넥션 진단값
 */
async function listen(connection, guild, memberIds, ms) {
  const receiver = connection.receiver;
  // 사람별 집계. `말하기` 는 복호화 **전에** 올라오는 신호이고 `패킷` 은 복호화 **후**입니다.
  // 그래서 이 두 숫자가 갈리는 것 자체가 답입니다 (아래 진단 표).
  const tally = new Map();
  const of = (userId) => {
    if (!tally.has(userId)) {
      tally.set(userId, {
        speaking: 0,
        packets: 0,
        bytes: 0,
        error: null,
        ssrc: null,
        subscription: null,
      });
    }
    return tally.get(userId);
  };

  // ★ **방에 있는 사람은 전부 미리 줄을 만들어 둡니다.**
  //   말 안 한 사람이 목록에서 아예 빠지면 "조용했다" 와 "안 잡힌다" 를 구분할 수 없습니다.
  //   실제로 "2명 있었는데 1명만 찍혔다" 를 받았는데, 그게 어느 쪽인지 알 수 없었습니다.
  for (const userId of memberIds) of(userId);

  const observers = [];
  const watched = new Set();
  const watch = (userId) => {
    if (watched.has(userId)) return;
    watched.add(userId);
    // ⚠️ `receiver.subscribe()` 는 **재생용** `connection.subscribe()` 와 다른 것입니다.
    // 이쪽은 받기, 그쪽은 보내기입니다. 불변조건 1 의 `subscribeTo()` 를 건드리지 않습니다.
    const onData = (chunk) => {
      const row = of(userId);
      row.packets += 1;
      row.bytes += chunk.length;
    };
    // 복호화 실패는 `stream.destroy(error)` 로 옵니다. 원문을 그대로 남깁니다 (3.1-4).
    const onError = (err) => {
      of(userId).error = err?.message ?? String(err);
    };
    const observer = observeReceiverStream(receiver, userId, { onData, onError });
    of(userId).subscription = observer.owned ? '진단 임시 구독' : '기존 기록 버퍼 관찰';
    observers.push(observer);
  };

  const onSpeaking = (userId) => {
    of(userId).speaking += 1;
    watch(userId);
  };
  receiver.speaking.on('start', onSpeaking);
  for (const userId of memberIds) watch(userId);

  const deafAfter = botDeafState(guild);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

  receiver.speaking.off('start', onSpeaking);
  // ★ ssrc 매핑이 왔는지 = 디스코드가 "이 사람이 이 번호로 보낸다" 를 알려줬는지.
  //   매핑이 없으면 아직 그 사람 소리는 한 번도 이 방에 오지 않은 것입니다.
  //   `ssrcMap` 은 라이브러리 내부라 실패해도 조용히 넘깁니다.
  for (const userId of tally.keys()) {
    try {
      of(userId).ssrc = Boolean(receiver.ssrcMap?.get?.(userId));
    } catch {
      of(userId).ssrc = null;
    }
  }
  for (const observer of observers) observer.stop();
  return { tally, deafAfter, ...peekNetworking(connection) };
}

/**
 * 세 숫자를 보고 "무엇이 막고 있는지"를 말해줍니다. 모르면 모른다고 합니다.
 *
 * 순수 함수로 떼어 둔 이유: 토큰 없이 `verify` 가 다섯 갈래를 다 확인할 수 있게 하려고요.
 * 진단이 엉뚱한 결론을 말하면 진단이 없는 것보다 나쁩니다.
 */
export function diagnose({ speaking, packets, deaf, dave }) {
  if (deaf?.serverDeaf) {
    return '❌ **서버에서 봇을 마이크 차단(서버 음소거/헤드셋 차단)** 해뒀습니다. 그것부터 풀어야 합니다.';
  }
  if (deaf?.selfDeaf) {
    return (
      '❌ **봇이 아직 귀를 막고 있습니다.** `rejoin({ selfDeaf: false })` 로는 안 열린다는 뜻입니다.\n' +
      '→ `guild-audio.js` 의 `selfDeaf: true` 를 바꿔야 합니다 (음악·읽어주기와 공유하는 커넥션입니다).'
    );
  }
  if (speaking === 0 && packets === 0) {
    return (
      '⚠️ **아무 신호도 오지 않았습니다.** 확인하는 동안 **정말 아무도 말하지 않았을 수도** 있습니다.\n' +
      '→ 두 사람 이상이 계속 말하면서 다시 해보세요. 그래도 0이면 수신 자체가 막힌 것입니다.'
    );
  }
  if (packets === 0) {
    return (
      '❌ **패킷은 도착하는데 복호화가 안 됩니다.**' +
      (dave ? ' 디스코드 **DAVE(종단간 암호화)** 가 켜진 채널입니다.' : '') +
      '\n→ 소리 녹음은 지금 구조로는 안 됩니다. 위의 오류 원문을 같이 알려주세요.'
    );
  }
  return '✅ **수신됩니다.** 30초 되돌리기를 만들 수 있습니다.';
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('음성수신확인')
      .setDescription('망고가 음성채널 소리를 받을 수 있는지 확인합니다 (저장하지 않습니다)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addIntegerOption((o) =>
        o
          .setName('초')
          .setDescription(`몇 초 동안 확인할지 (기본 ${DEFAULT_SEC}초, 최대 ${MAX_SEC}초)`)
          .setMinValue(5)
          .setMaxValue(MAX_SEC)
      ),

    async execute(interaction) {
      const seconds = interaction.options.getInteger('초') ?? DEFAULT_SEC;
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        throw userError(
          '먼저 음성채널에 들어가 주세요.\n' +
            '확인을 켠 사람이 그 방에 있어야만 동작합니다 — 아무도 없는 방을 봇만 듣게 두지 않기 위해서입니다.'
        );
      }

      // 다른 방에서 음악이 돌고 있으면 `connect()` 가 봇을 이 방으로 **옮겨버립니다.**
      // 듣고 있는 사람 입장에서는 노래가 그냥 끊깁니다. 그래서 옮기지 않고 거절합니다.
      const existing = peekGuildAudio(interaction.guildId);
      const here = existing?.connection?.joinConfig?.channelId;
      if (here && here !== channel.id) {
        throw userError(
          `망고가 지금 <#${here}> 에 있습니다. 그 방에서 뭔가 재생 중일 수 있어 옮기지 않았습니다.\n` +
            '같은 방으로 오셔서 다시 실행하거나, 재생을 먼저 멈춰주세요.'
        );
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // 진단 때문에 새로 들어왔는지 기억합니다. 그랬다면 끝나고 나가야 합니다.
      const joinedForProbe = !existing?.connection;
      const audio = getGuildAudio(channel.guild);
      const connection = await audio.connect(channel);
      if (connection.state.status !== VoiceConnectionStatus.Ready) {
        throw userError('음성채널 연결이 준비되지 않았습니다. 잠시 뒤에 다시 해보세요.');
      }

      const before = botDeafState(channel.guild);
      const wasSelfDeaf = connection.joinConfig.selfDeaf !== false;
      let rejoined = null;
      if (wasSelfDeaf) {
        // 커넥션을 끊지 않고 귀만 엽니다. 성공하면 재생 중인 소리는 그대로 이어집니다.
        rejoined = connection.rejoin({ selfDeaf: false });
        // 디스코드가 상태를 적용할 시간. 적용 여부는 아래에서 **실제 상태를 읽어** 확인합니다.
        await new Promise((r) => {
          const t = setTimeout(r, 1_500);
          t.unref?.();
        });
      }

      await interaction.editReply(
        `🎧 **${seconds}초 동안 듣습니다.** 지금 두 사람 이상이 계속 말해주세요.\n` +
          '소리는 **저장하지 않습니다.** 개수만 셉니다.'
      );

      const humans = [...channel.members.values()].filter((m) => !m.user.bot).map((m) => m.id);
      let result;
      try {
        result = await listen(connection, channel.guild, humans, seconds * 1_000);
      } finally {
        // 확인이 실패하든 성공하든 원래대로 귀를 막아둡니다.
        if (wasSelfDeaf) {
          try {
            connection.rejoin({ selfDeaf: true });
          } catch (err) {
            console.warn('[voice-probe] 귀 막기 복원 실패:', err.message);
          }
        }
        if (joinedForProbe && idleForProbe(audio)) {
          try {
            audio.destroy();
          } catch (err) {
            console.warn('[voice-probe] 음성채널에서 나가기 실패:', err.message);
          }
        }
      }

      const rows = [...result.tally.entries()]
        .sort((a, b) => b[1].packets - a[1].packets)
        .map(([userId, row]) => {
          const avg = row.packets ? Math.round(row.bytes / row.packets) : 0;
          // 아무것도 안 온 사람은 **왜** 안 왔는지까지 적습니다.
          // ssrc 매핑조차 없으면 그 사람 소리가 이 방에 한 번도 오지 않은 것입니다.
          const why =
            row.packets || row.speaking
              ? ''
              : row.ssrc === false
                ? ' → **아무 소리도 안 옴** (말을 안 했거나, 마이크가 꺼져 있거나, 이 사람 소리가 봇까지 오지 않음)'
                : ' → 신호 없음';
          return (
            `<@${userId}> — 말하기 **${row.speaking}**회 · opus 패킷 **${row.packets}**개` +
            (row.packets ? ` (평균 ${avg}바이트, 총 ${(row.bytes / 1024).toFixed(1)}KB)` : '') +
            (row.ssrc === false ? ' · ssrc 매핑 없음' : row.ssrc === true ? ' · ssrc 있음' : '') +
            (row.subscription ? ` · ${row.subscription}` : '') +
            why +
            (row.error ? `\n　　⚠️ 오류 원문: \`${row.error}\`` : '')
          );
        });

      const speaking = [...result.tally.values()].reduce((n, r) => n + r.speaking, 0);
      const packets = [...result.tally.values()].reduce((n, r) => n + r.packets, 0);
      const borrowed = [...result.tally.values()].filter((r) => r.subscription === '기존 기록 버퍼 관찰').length;
      const temporary = [...result.tally.values()].filter((r) => r.subscription === '진단 임시 구독').length;

      // ★ **나만 보기 메시지는 디스코드가 저장하지 않습니다.** 새로고침하거나 앱을 다시
      //   켜면 사라집니다. 진단 결과가 사라지면 숫자를 옮겨 적을 수도 없습니다.
      //   그래서 📢 로 채팅방에 남길 수 있게 합니다 (3.6-6a 의 그 버튼입니다).
      //   또 서버 로그에도 한 줄 남깁니다 — 나중에 `journalctl` 로 찾을 수 있게.
      console.log(
        `[voice-probe] ${seconds}초 · 사람 ${humans.length}명 · 말하기 ${speaking} · 패킷 ${packets} · ` +
          `귀 ${result.deafAfter?.selfDeaf ? '막힘' : '열림'} · 서버차단 ${result.deafAfter?.serverDeaf ? 'Y' : 'N'} · ` +
          `암호화 ${result.encryptionMode ?? '?'} · DAVE ${result.dave ? 'Y' : 'N'} · ` +
          `구독 기존 ${borrowed} 임시 ${temporary}` +
          [...result.tally.entries()]
            .map(([id, r]) => ` | ${id}: 말하기 ${r.speaking} 패킷 ${r.packets} ssrc ${r.ssrc}${r.error ? ` 오류 ${r.error}` : ''}`)
            .join('')
      );

      return interaction.editReply(
        withShareButton({
          content: [
          `## 🎧 음성 수신 확인 (${seconds}초)`,
          '',
          `**결론** — ${diagnose({ speaking, packets, deaf: result.deafAfter, dave: result.dave })}`,
          '',
          '**봇 상태**',
          `· 귀: 확인 전 ${before?.selfDeaf ? '막힘' : '열림'} → 확인 중 ` +
            `**${result.deafAfter?.selfDeaf ? '막힘' : '열림'}**` +
            (wasSelfDeaf ? ` (\`rejoin\` 요청 ${rejoined ? '성공' : '실패'})` : ' (원래 열려 있었음)'),
          `· 서버 차단: ${result.deafAfter?.serverDeaf ? '⚠️ 차단됨' : '없음'}`,
          `· 암호화 방식: \`${result.encryptionMode ?? '알 수 없음'}\``,
          `· DAVE(종단간 암호화): ${result.dave ? '**켜짐**' : '꺼짐'}`,
          `· 수신 구독: 기존 기록 버퍼 **${borrowed}명** · 진단 임시 **${temporary}명**`,
          '',
          `**사람별** (음성방 사람 ${humans.length}명)`,
          ...(rows.length ? rows : ['· 아무 신호도 없었습니다.']),
          '',
          '-# 소리는 저장하지 않았습니다. 확인이 끝나 봇은 다시 귀를 막았습니다' +
            (joinedForProbe && !audio.connection ? ' (그리고 음성채널에서 나갔습니다).' : '.'),
          '-# 이 화면은 나만 보이고 **새로고침하면 사라집니다.** 남기려면 📢 를 누르세요.',
          ].join('\n'),
        })
      );
    },
  },
];
