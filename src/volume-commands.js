// /음량 — 음악과 읽어주기의 소리 크기를 따로 맞춥니다.
//
// 왜 ffmpeg 으로 조절하는가:
//   discord.js 의 inlineVolume 을 쓰면 실시간으로 바꿀 수 있지만,
//   opus 를 PCM 으로 풀었다가 다시 인코딩해야 합니다.
//   이 프로젝트에는 순수 JS 인코더(opusscript)밖에 없어서 1코어 서버에서는 소리가 끊깁니다.
//   (ARCHITECTURE 3.2 절의 "재인코딩 회피" 가 통째로 깨집니다)
//
//   대신 ffmpeg 의 -af volume 을 씁니다. 그러면:
//     · 읽어주기 — 매 발화마다 새 ffmpeg 이 뜨므로 **바로** 반영됩니다.
//     · 음악     — 이미 흐르는 소리는 못 바꾸므로 다시 틀어야 합니다. 다만
//                  **새 소리를 다 준비한 뒤에 바꿔치기**하므로 끊기지 않습니다.
//                  대신 누른 뒤 1~2초쯤 지나 바뀝니다.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { volumePercent, setVolume, VOLUME_MAX, inRole } from './settings.js';
import { peekGuildAudio } from './audio/guild-audio.js';

/** 0~200 을 막대로. 한눈에 크기를 보여줍니다. */
function bar(percent) {
  const filled = Math.round((Math.min(percent, 100) / 100) * 10);
  const over = percent > 100 ? ` +${percent - 100}%` : '';
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + over;
}

// 봇을 나눠 돌릴 때(BOT_ROLE), 이 봇이 안 내는 소리는 조절해봐야 소용없습니다.
// 음악 봇의 `/음량` 에 읽어주기 칸이 있으면, 맞춰놓고 "왜 안 바뀌지" 가 됩니다.
const HAS_MUSIC = inRole('music');
const HAS_TTS = inRole('tts');

function status(guildId) {
  const lines = [];
  if (HAS_MUSIC) {
    const m = volumePercent(guildId, 'music');
    lines.push(`🎵 음악      \`${bar(m)}\` **${m}%**`);
  }
  if (HAS_TTS) {
    const t = volumePercent(guildId, 'tts');
    lines.push(`🗣️ 읽어주기  \`${bar(t)}\` **${t}%**`);
  }
  lines.push('', `\`/음량 ${HAS_MUSIC ? '음악' : '읽어주기'}:70\` 처럼 바꿉니다. 100이 원음이고 200까지 올릴 수 있습니다.`);
  return lines.join('\n');
}

export const commands = [
  {
    data: (() => {
      const b = new SlashCommandBuilder()
        .setName('음량')
        .setDescription(
          HAS_MUSIC && HAS_TTS
            ? '음악과 읽어주기의 소리 크기를 따로 맞춥니다 (비우면 현재 값만 봅니다)'
            : `${HAS_MUSIC ? '음악' : '읽어주기'} 소리 크기를 맞춥니다 (비우면 현재 값만 봅니다)`
        );
      const amount = (o, name) =>
        o.setName(name).setDescription('0~200 (100이 원음)').setRequired(false).setMinValue(0).setMaxValue(VOLUME_MAX);
      if (HAS_MUSIC) b.addIntegerOption((o) => amount(o, '음악'));
      if (HAS_TTS) b.addIntegerOption((o) => amount(o, '읽어주기'));
      return b;
    })(),
    async execute(interaction) {
      // 없는 옵션은 getInteger 가 null 을 줍니다. 역할에 없으면 아예 묻지 않은 것과 같습니다.
      const music = HAS_MUSIC ? interaction.options.getInteger('음악') : null;
      const tts = HAS_TTS ? interaction.options.getInteger('읽어주기') : null;

      // 인자 없이 실행하면 지금 값만 보여줍니다.
      if (music === null && tts === null) {
        return interaction.reply({ content: status(interaction.guildId), flags: MessageFlags.Ephemeral });
      }

      const changed = [];
      if (music !== null) {
        setVolume(interaction.guildId, 'music', music);
        changed.push(`🎵 음악 **${music}%**`);
      }
      if (tts !== null) {
        setVolume(interaction.guildId, 'tts', tts);
        changed.push(`🗣️ 읽어주기 **${tts}%**`);
      }

      let note = '';
      if (music !== null) {
        // 재생 중이면 듣던 지점부터 다시 틀어 바로 반영합니다.
        const audio = peekGuildAudio(interaction.guildId);
        if (audio?.reapplyVolume()) note = '\n(듣던 곳에서 곧 바뀝니다. 끊기지 않습니다)';
      }
      if (tts !== null) note += '\n(읽어주기는 다음 문장부터 바로 적용됩니다)';

      await interaction.reply(`🔊 ${changed.join(' · ')} 로 맞췄습니다.${note}`);
    },
  },
];
