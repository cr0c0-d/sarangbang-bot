// 봇 진입점.  실행: npm start
//
// 하는 일:
//   1. 디스코드에 로그인
//   2. 슬래시 명령어가 오면 해당 모듈로 넘겨줌
//   3. 메시지가 오면 음악 → TTS → 이미지 순서로 처리 기회를 줌
//   4. 이미지 기능이 켜져 있으면 갤러리 웹서버도 같이 띄움
import { Client, GatewayIntentBits, Events, ActivityType, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { commandMap } from './commands.js';
import { handleMusicMessage } from './music/commands.js';
import { handleTtsMessage } from './tts/index.js';
import { prewarm as prewarmTts } from './tts/synth.js';
import { ttsEnabled } from './settings.js';
import { handleImageMessage, handleImageComponent } from './images/commands.js';
import { startAutoCleanup } from './images/cleanup.js';
import { initStore } from './images/store.js';
import { initSettings, getWithSource } from './settings.js';
import { startWebServer } from './web/server.js';
import { peekGuildAudio } from './audio/guild-audio.js';
import { handleMusicComponent } from './music/panel.js';
import { handleHistoryComponent } from './music/commands.js';
import { initHistory, flushHistory } from './music/history.js';
import { adoptGalleryPanel } from './images/panel.js';
import { initPanelRegistry, cleanupPanelsOnStart, deleteMusicPanels } from './panel-registry.js';
import { initTimers, handleTimerComponent } from './timer/index.js';
import { initPolls, handlePollComponent, handlePollModal, restorePollDeadlines, flushPolls } from './poll/index.js';
import { handleMovieComponent } from './movie/index.js';
import { checkProviders, hasKey as hasTmdbKey } from './movie/tmdb.js';
import { handleFeatureComponent } from './feature-commands.js';
import { handleChannelComponent } from './channel-commands.js';
import { featureEnabled, FEATURES, inRole } from './settings.js';

/** 꺼진 기능을 쓰려 할 때 보여줄 안내. */
function featureOffMessage(key) {
  const f = FEATURES[key];
  return `${f.emoji} **${f.label}** 기능이 꺼져 있습니다.\n\`/기능\` 에서 켤 수 있습니다.`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // 음성채널 입장/퇴장 감지 (음악·TTS에 필수)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 메시지 내용 읽기 (개발자 포털에서 켜야 합니다)
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ 로그인 완료: ${c.user.tag}`);
  // 봇을 나눠 돌리면 로그가 두 벌 나옵니다. 어느 쪽인지 바로 보이게 찍습니다.
  console.log(`   맡은 역할: ${config.role} (${config.roleFeatures.join(', ')})`);
  // 서버마다 설정이 다를 수 있으므로 서버별로 찍습니다.
  for (const guild of c.guilds.cache.values()) {
    const s = (key) => {
      const { value, source } = getWithSource(guild.id, key);
      if (source === 'none') return '없음';
      const where = source === 'command' ? '명령어' : '.env';
      return `${Array.isArray(value) ? value.join(', ') : value} (${where})`;
    };
    console.log(`   [${guild.name}]`);
    if (inRole('music')) console.log(`     음악 채팅방  : ${s('musicTextChannelId')}`);
    if (inRole('tts')) console.log(`     읽어주기 채팅방: ${s('ttsTextChannelId')}`);
    if (inRole('images')) console.log(`     이미지 채널  : ${s('imageChannelIds')}`);
  }
  console.log('   설정을 바꾸려면 디스코드에서 /채널설정 을 쓰세요.');

  // 저장된 타이머를 되살립니다. (배포로 재시작해도 타이머가 사라지지 않게)
  if (inRole('timer')) initTimers(c).catch((err) => console.error('[timer] 복구 실패:', err.message));
  // 자동 마감 예약을 되살립니다. setTimeout 은 재시작하면 사라지므로,
  // 저장해둔 마감 시각을 보고 다시 겁니다. 이미 지난 것은 바로 닫힙니다.
  if (inRole('poll')) restorePollDeadlines(c);
  // TMDB 의 OTT 번호가 바뀌었는지 한 번 대조합니다. 조용히 틀리는 것보다 낫습니다.
  if (inRole('movie') && hasTmdbKey()) checkProviders();
  // 재시작 전에 띄워둔 제어판을 정리합니다.
  //   음악 제어판 → 지웁니다 (재시작하면 음악이 이어지지 않으므로 "재생 중" 이 거짓말)
  //   갤러리 버튼 → 되찾아 그대로 씁니다 (링크 버튼이라 재시작 후에도 동작)
  cleanupPanelsOnStart(c, adoptGalleryPanel);
  c.user.setActivity('/도움말', { type: ActivityType.Listening });

  // TTS 연결을 미리 데워둡니다.
  // 식은 연결에서 첫 발화는 약 1초, 따뜻하면 50~80ms 입니다 (실측).
  if (inRole('tts') && [...c.guilds.cache.keys()].some((id) => ttsEnabled(id))) {
    prewarmTts(config.tts.voice).then((ok) =>
      console.log(ok ? '   TTS 예열 완료 (첫 발화도 빠릅니다)' : '   TTS 예열 실패 (첫 발화만 조금 느립니다)')
    );
  }
});

// ── 슬래시 명령어 ───────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // 자동완성 (/타이머 의 시간 칸 등)
  if (interaction.isAutocomplete()) {
    const cmd = commandMap.get(interaction.commandName);
    if (cmd?.autocomplete) {
      try {
        await cmd.autocomplete(interaction);
      } catch (err) {
        console.error(`[자동완성 ${interaction.commandName}]`, err.message);
      }
    }
    return;
  }

  // 입력 창(모달) 제출. 지금은 투표 만들기 창 하나뿐입니다.
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('v:') || !inRole('poll')) return;
    if (!featureEnabled(interaction.guildId, 'poll')) {
      return interaction
        .reply({ content: featureOffMessage('poll'), flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    try {
      await handlePollModal(interaction);
    } catch (err) {
      console.error('[투표 만들기]', err);
      const content = `⚠️ ${err.message ?? '투표를 만들지 못했습니다.'}`;
      if (interaction.deferred) await interaction.editReply(content).catch(() => {});
      else if (!interaction.replied) await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // 버튼·드롭다운. customId 앞머리로 어느 기능인지 구분합니다.
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const isMusic = interaction.customId.startsWith('m:');
    const isTimer = interaction.customId.startsWith('t:');
    const isFeature = interaction.customId.startsWith('f:');
    const isImage = interaction.customId.startsWith('g:');
    const isChannel = interaction.customId.startsWith('c:');
    const isPoll = interaction.customId.startsWith('v:');
    const isMovie = interaction.customId.startsWith('mv:');
    if (!isMusic && !isTimer && !isFeature && !isImage && !isChannel && !isPoll && !isMovie) return;

    // 맡지 않은 기능의 버튼. 재시작 전에 남은 것일 수 있으므로 조용히 넘깁니다.
    if (
      (isMusic && !inRole('music')) ||
      (isTimer && !inRole('timer')) ||
      (isImage && !inRole('images')) ||
      (isPoll && !inRole('poll')) ||
      (isMovie && !inRole('movie'))
    ) {
      return;
    }

    // 꺼진 기능의 버튼은 막습니다. 기능 패널(f:) 버튼은 항상 통과해야 합니다.
    const needs = isMusic ? 'music' : isTimer ? 'timer' : isImage ? 'images' : isPoll ? 'poll' : isMovie ? 'movie' : null;
    if (needs && !featureEnabled(interaction.guildId, needs)) {
      return interaction
        .reply({ content: featureOffMessage(needs), flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    try {
      if (isFeature) await handleFeatureComponent(interaction);
      else if (isChannel) await handleChannelComponent(interaction);
      else if (isImage) await handleImageComponent(interaction);
      else if (isTimer) await handleTimerComponent(interaction);
      else if (isMovie) await handleMovieComponent(interaction);
      else if (isPoll) await handlePollComponent(interaction);
      // 지난 곡 보기·담기는 **재생 중이 아니어도** 되어야 하므로 먼저 가로챕니다.
      // handleMusicComponent 는 재생 중이 아니면 바로 되돌려보냅니다.
      else if (interaction.customId.startsWith('m:hist')) await handleHistoryComponent(interaction);
      else await handleMusicComponent(interaction, peekGuildAudio(interaction.guildId));
    } catch (err) {
      console.error('[버튼]', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  // 꺼진 기능의 명령어는 여기서 한 번에 막습니다.
  // 각 명령어 안에서 따로 검사하면 새 명령어를 추가할 때 반드시 빠뜨리게 됩니다.
  if (command.feature && !featureEnabled(interaction.guildId, command.feature)) {
    return interaction
      .reply({ content: featureOffMessage(command.feature), flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[명령어 ${interaction.commandName}]`, err);
    const content = `⚠️ ${err.message ?? '알 수 없는 오류가 났습니다.'}`;
    // 이미 응답했는지에 따라 답하는 방법이 다릅니다.
    if (interaction.deferred) await interaction.editReply(content).catch(() => {});
    else if (!interaction.replied) await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ── 일반 메시지 ─────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  try {
    // 이미지 저장은 다른 기능을 막지 않습니다.
    // (사진에 설명글을 달아 올리면, 저장도 하고 그 글을 읽어주기도 해야 하므로)
    if (inRole('images')) await handleImageMessage(message);

    // 반면 아래 둘은 서로 배타적입니다.
    // 유튜브 링크는 "재생"이 맞지, 링크를 소리내어 읽는 건 의미가 없기 때문입니다.
    // 따라서 음악이 처리한 메시지는 TTS로 넘어가지 않습니다.
    //
    // 봇을 나눠 돌리면(BOT_ROLE) 이 배타 관계가 **봇 사이에서는 성립하지 않습니다.**
    // 음악 봇이 링크를 처리해도 나머지 봇은 그 사실을 모르므로, 링크를 읽어버립니다.
    // 그래서 읽어주기 쪽에서 링크를 '링크' 로 바꿔 읽는 정제(cleanText)가 그대로 필요합니다.
    if (inRole('music') && (await handleMusicMessage(message))) return;
    if (inRole('tts')) await handleTtsMessage(message);
  } catch (err) {
    console.error('[메시지 처리]', err);
  }
});

// ── 아무도 없는 음성채널에 혼자 남으면 나가기 ────────────────

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // 누군가 음성채널에 들어오면 곧 읽어주기를 쓸 가능성이 높습니다.
  // 그때 미리 데워두면 첫 메시지도 즉시 나옵니다.
  if (inRole('tts') && newState?.channel && !newState.member?.user?.bot && ttsEnabled(newState.guild.id)) {
    prewarmTts(config.tts.voice).catch(() => {});
  }

  const channel = oldState.channel;
  if (!channel) return;

  const audio = peekGuildAudio(oldState.guild.id);
  if (!audio || audio.connection?.joinConfig.channelId !== channel.id) return;

  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) {
    console.log('[voice] 음성채널에 아무도 없어 나갑니다.');
    audio.destroy();
  }
});

// ── 시작 ────────────────────────────────────────────────────

// 채널 설정은 명령어로 언제든 바뀔 수 있으므로, 저장소는 항상 준비해둡니다.
await initSettings();
await initPanelRegistry();
if (inRole('poll')) await initPolls();
if (inRole('music')) await initHistory();

// 갤러리 웹서버는 **이미지를 맡은 봇만** 띄웁니다.
// 둘 다 띄우면 나중에 뜬 쪽이 "포트가 이미 쓰이고 있다" 로 죽습니다.
let webServer = null;
if (inRole('images')) {
  await initStore();
  webServer = await startWebServer();
  startAutoCleanup();
}

await client.login(config.token).catch((err) => {
  // 봇이 둘이므로 **어느 파일을 고쳐야 하는지**까지 알려줘야 합니다.
  const envFile = config.role === 'music' ? '.env.music' : '.env';
  const msg = String(err.message ?? '');

  console.error(`❌ 로그인 실패 (${config.botName}): ${msg}`);

  if (/disallowed intents|privileged intent/i.test(msg)) {
    // 토큰은 멀쩡한데 개발자 포털에서 인텐트를 안 켠 경우입니다.
    // 예전에는 여기서도 "토큰을 확인하세요" 라고 해서 엉뚱한 곳을 뒤지게 만들었습니다.
    console.error('   → 토큰 문제가 아닙니다. 이 봇의 **MESSAGE CONTENT INTENT** 가 꺼져 있습니다.');
    console.error('      Discord Developer Portal → 이 애플리케이션 → Bot →');
    console.error('      Privileged Gateway Intents → MESSAGE CONTENT INTENT 켜기 → Save Changes');
    console.error(`      (${envFile} 의 토큰에 해당하는 앱입니다. 봇마다 따로 켜야 합니다)`);
  } else if (/token|unauthorized|401/i.test(msg)) {
    console.error(`   → ${envFile} 의 DISCORD_TOKEN 을 확인해주세요.`);
    console.error('      Developer Portal → Bot → Reset Token 으로 새로 받으면 됩니다.');
  } else {
    console.error(`   → ${envFile} 의 DISCORD_TOKEN 과 서버의 인터넷 연결을 확인해주세요.`);
  }
  process.exit(1);
});

// ── 종료 처리 ───────────────────────────────────────────────

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} 수신, 정리 중...`);

  // 제어판을 남겨두면 봇이 꺼진 뒤에도 "지금 재생 중" 으로 보입니다.
  // 디스코드가 늦게 답할 수 있으니 3초까지만 기다리고 나갑니다.
  await Promise.race([deleteMusicPanels(client).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);

  for (const guild of client.guilds.cache.values()) {
    peekGuildAudio(guild.id)?.destroy();
  }
  // 방금 튼 곡이 지난 목록에 안 남을 수 있습니다. 저장이 끝날 때까지 기다립니다.
  await flushHistory().catch(() => {});
  await flushPolls().catch(() => {});

  webServer?.close();
  client.destroy();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[처리되지 않은 오류]', err));
