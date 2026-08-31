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
import { handleImageMessage, } from './images/commands.js';
import { initStore } from './images/store.js';
import { initSettings, getWithSource } from './settings.js';
import { startWebServer } from './web/server.js';
import { peekGuildAudio } from './audio/guild-audio.js';
import { handleMusicComponent } from './music/panel.js';

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
  // 서버마다 설정이 다를 수 있으므로 서버별로 찍습니다.
  for (const guild of c.guilds.cache.values()) {
    const s = (key) => {
      const { value, source } = getWithSource(guild.id, key);
      if (source === 'none') return '없음';
      const where = source === 'command' ? '명령어' : '.env';
      return `${Array.isArray(value) ? value.join(', ') : value} (${where})`;
    };
    console.log(`   [${guild.name}]`);
    console.log(`     음악 채팅방  : ${s('musicTextChannelId')}`);
    console.log(`     읽어주기 채팅방: ${s('ttsTextChannelId')}`);
    console.log(`     이미지 채널  : ${s('imageChannelIds')}`);
  }
  console.log('   설정을 바꾸려면 디스코드에서 /채널설정 을 쓰세요.');
  c.user.setActivity('/도움말', { type: ActivityType.Listening });
});

// ── 슬래시 명령어 ───────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // 음악 제어판의 버튼·드롭다운. customId 가 'm:' 으로 시작합니다.
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith('m:')) return;
    try {
      await handleMusicComponent(interaction, peekGuildAudio(interaction.guildId));
    } catch (err) {
      console.error('[제어판]', err);
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
    await handleImageMessage(message);

    // 반면 아래 둘은 서로 배타적입니다.
    // 유튜브 링크는 "재생"이 맞지, 링크를 소리내어 읽는 건 의미가 없기 때문입니다.
    // 따라서 음악이 처리한 메시지는 TTS로 넘어가지 않습니다.
    if (await handleMusicMessage(message)) return;
    await handleTtsMessage(message);
  } catch (err) {
    console.error('[메시지 처리]', err);
  }
});

// ── 아무도 없는 음성채널에 혼자 남으면 나가기 ────────────────

client.on(Events.VoiceStateUpdate, (oldState) => {
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

// 채널 설정은 명령어로 언제든 바뀔 수 있으므로, 저장소와 웹서버는 항상 준비해둡니다.
await initSettings();
await initStore();
const webServer = await startWebServer();

await client.login(config.token).catch((err) => {
  console.error('❌ 로그인 실패:', err.message);
  console.error('   → .env 의 DISCORD_TOKEN 을 확인해주세요.');
  process.exit(1);
});

// ── 종료 처리 ───────────────────────────────────────────────

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} 수신, 정리 중...`);
  for (const guild of client.guilds.cache.values()) {
    peekGuildAudio(guild.id)?.destroy();
  }
  webServer?.close();
  client.destroy();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[처리되지 않은 오류]', err));
