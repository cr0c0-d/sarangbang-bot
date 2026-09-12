#!/usr/bin/env bash
set -euo pipefail

# bgutil의 서버와 yt-dlp 플러그인은 주 버전이 맞아야 합니다. 보안 수정이 포함된 버전을 고정합니다.
provider_version="${SARANGBANG_POT_VERSION:-2.0.0}"
provider_dir="${SARANGBANG_POT_DIR:-$HOME/.local/share/sarangbang-bgutil-provider}"
ytdlp_venv="${YTDLP_VENV:-$HOME/.venv-ytdlp}"
service_name="sarangbang-pot-provider@$(id -un).service"

for command_name in git npm npx sudo; do
  command -v "$command_name" >/dev/null || {
    echo "필요한 명령이 없습니다: $command_name" >&2
    exit 1
  }
done

if [[ ! -x "$ytdlp_venv/bin/pip" || ! -x "$ytdlp_venv/bin/yt-dlp" ]]; then
  echo "yt-dlp 가상환경이 없습니다: $ytdlp_venv" >&2
  echo '먼저 docs/ORACLE-CLOUD.md 5절의 pip 설치를 진행해주세요.' >&2
  exit 1
fi

mkdir -p "$(dirname "$provider_dir")"
if [[ -d "$provider_dir/.git" ]]; then
  git -C "$provider_dir" fetch --tags --prune
else
  git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$provider_dir"
fi
git -C "$provider_dir" checkout --detach "$provider_version"

(
  cd "$provider_dir/server"
  npm ci
  npx tsc
)

"$ytdlp_venv/bin/pip" install -U 'yt-dlp[default]' "bgutil-ytdlp-pot-provider==$provider_version"

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sudo install -m 0644 "$repo_dir/deploy/sarangbang-pot-provider@.service" \
  /etc/systemd/system/sarangbang-pot-provider@.service
sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"

echo
echo "설치 완료: bgutil-ytdlp-pot-provider $provider_version"
sudo systemctl is-active "$service_name"
echo
echo '.env와 .env.music에 YTDLP_POT_PROVIDER=true를 넣고 두 봇을 재시작하세요.'
