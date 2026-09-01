// 모든 슬래시 명령어를 한곳에 모읍니다.
// 새 명령어를 만들면 여기 배열에만 추가하면 됩니다.
//
// 기능이 꺼져 있어도 명령어는 항상 전부 등록합니다.
// 채널을 /채널설정 으로 언제든 바꿀 수 있게 되면서, 등록 시점에 켜짐/꺼짐을
// 판단하면 "설정하려는데 설정할 명령어가 없는" 상황이 생기기 때문입니다.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { commands as musicCommands } from './music/commands.js';
import { commands as ttsCommands } from './tts/index.js';
import { commands as imageCommands } from './images/commands.js';
import { commands as channelCommands } from './channel-commands.js';
import { commands as timerCommands } from './timer/index.js';
import { commands as featureCommands } from './feature-commands.js';
import { getWithSource } from './settings.js';

const basicCommands = [
  {
    data: new SlashCommandBuilder().setName('도움말').setDescription('쓸 수 있는 기능을 봅니다'),
    async execute(interaction) {
      const g = interaction.guildId;
      const musicText = getWithSource(g, 'musicTextChannelId');
      const ttsText = getWithSource(g, 'ttsTextChannelId');
      const imageCh = getWithSource(g, 'imageChannelIds');

      const embed = new EmbedBuilder()
        .setTitle('🤖 봇 사용법')
        .setColor(0x5865f2)
        .setDescription('설정은 `/기능` 으로 켜고 끄고, `/채널설정` 으로 채널을 정합니다.')
        .addFields(
          {
            name: '🎵 음악',
            value: [
              '`/재생 <링크 또는 검색어>` — 재생 (재생목록 링크도 됩니다)',
              musicText.source === 'none'
                ? '아무 채팅방에 유튜브 링크를 붙여넣어도 재생됩니다.'
                : `<#${musicText.value}> 에 유튜브 링크만 붙여넣어도 재생됩니다.`,
              '여러 링크를 한꺼번에 붙여넣어도 **보낸 순서대로** 대기열에 들어갑니다.',
              '**`/대기열`** — 이전·다음·일시정지·반복·정지, 순서변경·빼기 **전부 버튼**입니다',
              '`/순서이동 <번호> <새번호>` — 정밀 조작 · `/나가기` — 음성채널에서 나가기',
            ].join('\n'),
          },
          {
            name: '🗣️ 읽어주기 (TTS)',
            value:
              ttsText.source === 'none'
                ? '읽어줄 채팅방이 없어 꺼져 있습니다.\n`/채널설정` 에서 "읽어주기 채팅방"을 지정하세요.'
                : [
                    `<#${ttsText.value}> 에 글을 쓰면 음성채널에서 읽어줍니다.`,
                    '맨 앞에 `//` 를 붙이면 읽지 않습니다.',
                    '`/내목소리` — **사람마다 다른 목소리** (14종) · `/목소리` — 서버 기본값',
                    '`/읽어주기 켜기:false` — 끄기',
                  ].join('\n'),
          },
          {
            name: '⏰ 타이머',
            value: [
              '`/타이머 15분` — 시간이 되면 음성으로 알려줍니다',
              '`1시간 30분`, `90m` 처럼 써도 되고, 칸을 비우면 자주 쓰는 시간이 목록으로 나옵니다.',
              '`/알람등록 라면 3분` — 단어로 등록해두면 `/타이머 라면` 으로 바로 쓸 수 있습니다',
              '`/타이머목록` — 진행 중인 타이머 보기 + 버튼으로 취소',
            ].join('\n'),
          },
          {
            name: '🖼️ 이미지 정리',
            value:
              imageCh.source === 'none'
                ? [
                    '봇이 볼 수 있는 **모든 채널**의 사진을 자동으로 정리합니다. (기본값)',
                    '폴더 이름은 **채널 이름**을 그대로 씁니다.',
                    '특정 채널만 원하면 `/채널설정` 에서 "이미지 채널"을 지정하세요.',
                    '`/갤러리` — 여러 장 골라 한 번에 받는 웹페이지 주소',
                    '`/폴더` — 이 채널의 저장 폴더 보기·바꾸기 · `/폴더목록` · `/정리` — 용량 관리',
                  ].join('\n')
                : [
                    `${imageCh.value.map((id) => `<#${id}>`).join(' ')} 에 올린 사진만 정리합니다.`,
                    '폴더 이름은 기본적으로 **채널 이름**을 씁니다. (스레드면 스레드 이름)',
                    '`/폴더 <이름>` — 이 채널의 폴더를 다른 이름으로 바꾸기',
                    '`/갤러리` — 여러 장 골라 한 번에 받는 웹페이지 주소',
                    '`/폴더` `/폴더목록` `/정리`',
                  ].join('\n'),
          }
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
];

/**
 * 명령어에 "어느 기능에 속하는지" 표를 붙입니다.
 * 모듈 단위로 한 줄씩 붙이므로, 명령어를 추가해도 표를 따로 고칠 일이 없습니다.
 * (명령어마다 직접 적으면 반드시 빠뜨리는 것이 생깁니다)
 *
 * index.js 가 이 값을 보고 꺼진 기능의 명령어를 막습니다.
 * `/기능` `/채널설정` `/도움말` 은 태그가 없어 **항상 동작합니다** —
 * 다 꺼놓고 다시 켤 방법이 없으면 안 되기 때문입니다.
 */
const tag = (feature, cmds) => cmds.map((c) => ({ ...c, feature }));

export const allCommands = [
  ...basicCommands,
  ...featureCommands,
  ...channelCommands,
  ...tag('music', musicCommands),
  ...tag('tts', ttsCommands),
  ...tag('timer', timerCommands),
  ...tag('images', imageCommands),
];

/** 이름 → 명령어 객체 */
export const commandMap = new Map(allCommands.map((c) => [c.data.name, c]));
