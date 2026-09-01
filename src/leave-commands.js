// /나가기 — 음성채널에서 나갑니다.
//
// **어느 기능에도 속하지 않습니다.** 음악도 읽어주기도 타이머 알람도 전부
// 같은 음성 커넥션(GuildAudio)을 쓰기 때문입니다.
//
// 원래는 음악 명령어 안에 있었는데, 봇을 둘로 나누면서 문제가 됐습니다.
// 음악을 떼어내면 망고 쪽에는 **음성채널에서 나올 방법이 사라집니다.**
// 읽어주기도 음성채널에 들어가므로 반드시 양쪽 봇에 다 있어야 합니다.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { peekGuildAudio } from './audio/guild-audio.js';

export const commands = [
  {
    data: new SlashCommandBuilder().setName('나가기').setDescription('음성채널에서 나갑니다'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (!audio) return interaction.reply({ content: '음성채널에 있지 않습니다.', flags: MessageFlags.Ephemeral });
      audio.destroy();
      await interaction.reply('👋 음성채널에서 나왔습니다.');
    },
  },
];
