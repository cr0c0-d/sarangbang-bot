# 망고를 Oracle Cloud Always Free 에 올리기

계정만 만들어둔 상태에서 시작해 봇이 24시간 돌아가기까지의 전체 과정입니다.
리눅스를 처음 다뤄도 따라올 수 있게 **명령어를 그대로 복사해 붙여넣는 방식**으로 썼습니다.

> 이 문서의 Oracle 무료 한도 수치는 **2026-08-31 기준**입니다.
> Oracle이 정책을 바꿀 수 있으니 실제 값은
> [공식 Always Free 문서](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)에서 확인하세요.

---

## 0. 시작 전에 — 무엇을 공짜로 받는가

| 자원 | Always Free 한도 | 이 봇에 필요한 양 |
|---|---|---|
| ARM(Ampere A1) | 총 **2 OCPU / 12GB RAM** (여러 대로 쪼갤 수 있음) | 1 OCPU / 6GB면 넉넉 |
| AMD 소형 | `VM.Standard.E2.1.Micro` **2대** (각 1/8 OCPU, 1GB RAM) | 빠듯하지만 동작 |
| 디스크 | 부팅+블록 합쳐 **200GB** (인스턴스당 최소 47GB) | 47GB로 시작, 사진이 쌓임 |
| 외부로 나가는 트래픽 | 월 **10TB** | 음악 스트리밍 약 30MB/시간 — 전혀 문제 없음 |

**ARM 쪽이 훨씬 좋습니다.** 그리고 이 봇은 ARM에서 그대로 돌아갑니다 — 미리 확인했습니다.

- `ffmpeg-static` 의 linux-arm64 빌드에 `--enable-libopus` 포함 (음악 재생의 핵심)
- `yt-dlp` 도 `yt-dlp_linux_aarch64` 를 공식 배포하며, `npm run update-ytdlp` 가 알아서 골라 받습니다

> ⚠️ **32비트 ARM(armv7l)은 지원하지 않습니다.** yt-dlp가 비압축 바이너리를 배포하지 않기 때문입니다.
> Oracle Ampere는 64비트라 해당 없습니다. 라즈베리파이에 올릴 거라면 64비트 OS를 쓰세요.

---

## 1. 먼저 알아야 할 함정 3가지

이걸 모르고 시작하면 반드시 막힙니다. 순서대로 읽어주세요.

### 함정 1 — ARM 인스턴스가 "용량 없음"으로 안 만들어진다

`Out of host capacity` 라는 에러가 가장 흔한 첫 관문입니다. 무료 ARM은 인기가 많아 자주 동납니다.

에러 문구는 대략 이렇습니다.

> 가용성 도메인 VM.Standard.A1.Flex에서 AD-1 셰이프에 대한 용량이 부족합니다.
> 다른 가용성 도메인에 인스턴스를 생성하거나 나중에 다시 시도하십시오.

**먼저 알아둘 두 가지 제약** (Oracle 공식 문서 기준)

- **리전은 못 바꿉니다.** Always Free는 **홈 리전에서만** 무료입니다.
  다른 리전에 만들면 정상 요금이 청구됩니다. 홈 리전은 가입할 때 정해지고 나중에 못 바꿉니다.
- **한국 리전은 가용성 도메인이 1개뿐입니다.** 서울(ap-seoul-1), 춘천(ap-chuncheon-1) 모두
  AD가 하나라서, Oracle이 첫 번째로 권하는 "다른 AD에서 시도"가 **애초에 불가능**합니다.
  (콘솔의 가용성 도메인 목록에 AD-1 하나만 보이면 이 경우입니다)

**대처법 — 위에서부터 해보세요**

| 순서 | 방법 | 효과 | 비용 |
|---|---|---|---|
| 1 | **AMD 소형으로 지금 시작** | 거의 항상 성공. 오늘 바로 봇을 띄울 수 있음 | 0원 |
| 2 | **더 작게 요청** (1 OCPU / 6GB) | 자리가 날 확률이 올라감 | 0원 |
| 3 | **결함 도메인 지정 해제** | 에러 문구가 직접 권하는 방법 | 0원 |
| 4 | **재시도 스크립트** | 자리는 수시로 나고 사라짐. 사람이 계속 누를 수 없음 | 0원 |
| 5 | **Pay As You Go 전환** | Oracle이 공식적으로 권하는 해결책. 함정 2도 같이 해결됨 | 결제수단 등록 (한도 내 사용 시 0원) |

**1번을 권합니다.** ARM이 될 때까지 기다리지 말고 AMD로 먼저 띄워두세요.
`VM.Standard.E2.1.Micro`(1/8 OCPU, 1GB RAM)는 거의 항상 자리가 있고,
이 봇은 여기서도 돕니다 (Node 약 150MB + ffmpeg 약 50MB + yt-dlp 약 100MB).
**단 4단계에서 스왑 파일을 꼭 만드세요.** 나중에 ARM 자리가 나면 그때 옮기면 됩니다.

### ARM 자리가 날 때까지 자동으로 재시도하기

콘솔에서 사람이 계속 "생성" 버튼을 누르는 건 현실적이지 않습니다.
Oracle **Cloud Shell**(콘솔 우측 상단 `>_` 아이콘, 브라우저에서 바로 열리고 이미 로그인된 상태)에서
아래를 순서대로 실행하면 자리가 날 때까지 알아서 재시도합니다.

> 먼저 콘솔에서 **VCN을 하나 만들어두세요.** (Networking → Virtual Cloud Networks →
> VCN with Internet Connectivity) VCN 생성은 용량과 무관하므로 항상 성공합니다.

**(1) 필요한 ID들을 알아냅니다**

```bash
oci iam availability-domain list --query 'data[].name' --raw-output
```

```bash
oci compute image list --compartment-id "$OCI_TENANCY" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC --query 'data[0].id' --raw-output
```

```bash
oci network subnet list --compartment-id "$OCI_TENANCY" --query 'data[].{이름:"display-name",id:id}' --output table
```

**(2) SSH 키를 만듭니다** (콘솔에서 이미 받아둔 키가 있으면 건너뛰세요)

```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/oci_bot -N "" && cat ~/.ssh/oci_bot.pub
```

> 🔑 개인키 `~/.ssh/oci_bot` 을 **반드시 내 PC로 내려받아 두세요.**
> Cloud Shell 우측 상단 메뉴의 **Download** 기능을 쓰면 됩니다. 이게 없으면 서버에 못 들어갑니다.

**(3) 재시도 스크립트를 실행합니다**

위에서 얻은 값을 세 줄에 채워 넣고 실행하세요. 성공할 때까지 3분마다 다시 시도합니다.

```bash
AD="여기에_가용성도메인_이름"
IMAGE="여기에_이미지_OCID"
SUBNET="여기에_서브넷_OCID"

n=0
while true; do
  n=$((n+1))
  if oci compute instance launch \
      --availability-domain "$AD" --compartment-id "$OCI_TENANCY" \
      --shape VM.Standard.A1.Flex --shape-config '{"ocpus":1,"memoryInGBs":6}' \
      --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
      --display-name sarangbang-bot \
      --metadata "{\"ssh_authorized_keys\":\"$(cat ~/.ssh/oci_bot.pub)\"}" \
      > /tmp/ok.json 2>/tmp/err.txt; then
    echo "✅ 성공! ($n번째 시도)"; break
  fi
  if grep -qi "capacity" /tmp/err.txt; then
    echo "$(date +%H:%M:%S)  용량 없음 — $n번째 시도, 3분 후 재시도"
    sleep 180
  else
    echo "❌ 용량 문제가 아닌 다른 에러입니다:"; cat /tmp/err.txt; break
  fi
done
```

> ⚠️ **Cloud Shell 탭을 닫으면 스크립트도 멈춥니다.** 탭을 열어둔 채로 두세요.
> Cloud Shell은 유휴 시간이 길면 세션이 끊기는데, 이 스크립트는 계속 출력을 내므로 유지됩니다.
> 그래도 몇 시간 뒤 끊길 수 있으니, 끊기면 다시 실행하면 됩니다.
> 용량 문제가 아닌 에러가 나오면 바로 멈추고 내용을 보여주므로, 잘못된 ID를 넣었는지 알 수 있습니다.

### 그래도 안 되면 — Pay As You Go 전환

Oracle 공식 문서가 "out of host capacity" 해결책으로 **직접 안내하는 방법**입니다.

> 계정을 Pay as You Go로 업그레이드하면 더 많은 종류의 컴퓨트 자원에 접근할 수 있습니다.
> 업그레이드 후에도 **Always Free 자원에는 요금을 부과하지 않으며**, 한도를 넘는 사용분에만 과금됩니다.

즉 결제수단만 등록하고 **Always Free 한도 안에서만 쓰면 청구액은 0원**입니다.
게다가 아래 **함정 2(유휴 회수)** 도 같이 해결됩니다.

> ⚠️ 다만 결제수단이 등록되므로 **한도를 넘기면 실제로 청구됩니다.**
> 전환한다면 Oracle 콘솔에서 **예산 알림(Budgets)** 을 1달러 정도로 걸어두세요.
> 뭔가 잘못돼서 과금이 시작되면 바로 알 수 있습니다.

### 함정 2 — 놀고 있는 인스턴스는 Oracle이 회수해간다 ⚠️ 이 봇에 특히 위험

Oracle은 **Always Free 계정의 놀고 있는 인스턴스를 회수**합니다.
7일 동안 아래 조건을 **전부** 만족하면 대상이 됩니다.

- CPU 사용률(95 백분위) 20% 미만
- 네트워크 사용률 20% 미만
- 메모리 사용률 20% 미만 (A1 계열만 해당)

**개인용 디스코드 봇은 정확히 이 조건에 걸립니다.** 며칠 아무도 안 쓰면 조용하니까요.
즉 **봇이 정상 동작 중인데도 서버가 사라질 수 있습니다.**

**선택지 두 가지 — 결정하고 넘어가세요.**

| 방법 | 내용 | 비용 |
|---|---|---|
| **A. 그냥 감수** | 회수되면 이 문서로 다시 만든다. `.env`와 사진은 미리 백업해둘 것 | 0원 |
| **B. Pay As You Go로 전환** (권장) | 계정을 PAYG로 올리면 회수 대상에서 빠집니다. **Always Free 한도 안에서 쓰는 한 요금은 0원** | 결제수단 등록 필요 |

> B를 고를 때 주의: 결제수단이 등록되므로 **무료 한도를 넘기면 실제로 청구됩니다.**
> 한도를 넘길 일은 거의 없지만, 걱정되면 Oracle 콘솔에서 예산 알림(Budget)을 걸어두세요.

### 함정 3 — 방화벽이 두 겹이다

Oracle은 포트를 열려면 **두 군데**를 다 열어야 합니다.

1. **클라우드 쪽** — VCN의 Security List 또는 Network Security Group
2. **서버 안쪽** — 우분투/오라클리눅스 이미지에 `iptables` 규칙이 미리 들어있어 SSH 말고 전부 막습니다

콘솔에서 1번만 열고 "안 되네?" 하는 경우가 대부분입니다.

**다만 이 문서는 포트를 아예 열지 않는 방법(SSH 터널)을 기본으로 권합니다.**
그러면 이 함정 자체를 피할 수 있습니다. 자세한 건 8단계에서.

---

## 2. 인스턴스 만들기

Oracle 콘솔은 화면이 자주 바뀌므로 클릭 경로 대신 **넣어야 할 값**만 적습니다.
콘솔에서 **Compute → Instances → Create instance** 로 가서 아래대로 채우세요.

| 항목 | 값 |
|---|---|
| 이름 | `sarangbang-bot` (아무거나) |
| 이미지 | **Canonical Ubuntu 24.04** (또는 22.04) |
| Shape | **VM.Standard.A1.Flex** (ARM) — 안 되면 아래 참고 |
| OCPU / 메모리 | **1 OCPU / 6 GB** (2/12를 다 쓰지 마세요. 작을수록 잘 생성됩니다) |
| 결함 도메인(Fault Domain) | **지정하지 마세요** (자동에 맡기면 생성 성공률이 올라갑니다) |
| 부팅 볼륨 | 기본값(47GB). 사진을 많이 모을 거면 100GB까지 늘려도 무료 한도 안 (총 200GB) |
| 네트워크 | 새 VCN 자동 생성 + **공용 IP 할당(Assign a public IPv4 address) 켜기** |
| SSH 키 | **Save private key** 눌러 파일 저장 |

> 🔑 **SSH 개인키는 이때만 받을 수 있습니다.** 잃어버리면 서버에 못 들어갑니다.
> 안전한 곳에 보관하세요. 이건 서버 접속 비밀번호와 같습니다.

> 🔴 **여기서 `Out of host capacity` 가 나면** 정상입니다. 대부분 여기서 막힙니다.
> **함정 1** 로 돌아가서 대처법을 보세요. 요약하면: 급하면 아래 AMD로 먼저 시작하고,
> ARM은 재시도 스크립트를 걸어두면 됩니다.

**ARM이 계속 안 될 때 — AMD로 먼저 시작하기**

| 항목 | 값 |
|---|---|
| Shape | **VM.Standard.E2.1.Micro** (AMD) |
| OCPU / 메모리 | 고정 (1/8 OCPU, 1GB) — 선택 불가 |
| 나머지 | 위 표와 동일 |

성능은 떨어지지만 이 봇은 정상 동작합니다. 대신 **4단계의 스왑 파일 생성을 반드시** 하세요.
1GB로는 `npm install` 도중에 메모리가 모자랄 수 있습니다.

만들어지면 인스턴스 화면의 **Public IP address** 를 적어두세요. 아래에서 `<서버IP>` 로 씁니다.

---

## 3. 서버에 접속하기

받은 개인키 파일(예: `ssh-key.key`)이 있는 폴더에서 실행합니다.
윈도우는 PowerShell이나 Git Bash를 쓰면 됩니다.

먼저 키 파일 권한을 잠급니다 (권한이 열려 있으면 SSH가 거부합니다).

```bash
chmod 600 ssh-key.key
```

접속합니다. 우분투 이미지의 기본 사용자 이름은 `ubuntu` 입니다.

```bash
ssh -i ssh-key.key ubuntu@<서버IP>
```

`Are you sure you want to continue connecting?` 이 나오면 `yes` 를 입력하세요.
프롬프트가 `ubuntu@sarangbang-bot:~$` 로 바뀌면 성공입니다.

**이 시점부터 나오는 명령어는 전부 서버 안에서 실행하는 것입니다.**

### `Connection timed out` 이 나올 때

```
ssh: connect to host 1.2.3.4 port 22: Connection timed out
```

**`Connection refused` 가 아니라 `timed out` 이라는 게 핵심 단서입니다.**

| 메시지 | 의미 |
|---|---|
| `Connection refused` | 서버까지는 도달했는데 22번 포트가 닫혀 있음 (SSH 데몬 문제) |
| **`Connection timed out`** | **패킷이 서버에 도달조차 못 함 — 방화벽 또는 라우팅 문제** |

즉 서버 안이 아니라 **Oracle 쪽 네트워크 설정**을 봐야 합니다. 흔한 원인 4가지입니다.

1. **서브넷의 Security List 에 22번 포트 인바운드 규칙이 없음**
2. **라우트 테이블에 인터넷 게이트웨이(0.0.0.0/0 → IGW) 경로가 없음**
3. **인스턴스가 사설(Private) 서브넷에 들어감** — VCN 마법사는 공용/사설 서브넷을 **둘 다** 만듭니다.
   재시도 스크립트에서 서브넷을 고를 때 사설 쪽을 고르면 이 증상이 납니다.
4. 인스턴스가 아직 부팅 중이거나 `RUNNING` 상태가 아님

#### 한 번에 진단하기

Cloud Shell 에 아래를 통째로 붙여넣으세요. 무엇이 문제인지 짚어줍니다.

```bash
INST=$(oci compute instance list --compartment-id "$OCI_TENANCY" --query 'data[0].id' --raw-output 2>/dev/null)
STATE=$(oci compute instance get --instance-id "$INST" --query 'data."lifecycle-state"' --raw-output)
echo "── 인스턴스 상태: $STATE"
[ "$STATE" != "RUNNING" ] && echo "   ⚠️ RUNNING 이 아닙니다. 콘솔에서 시작하거나 부팅을 기다리세요."

VNIC=$(oci compute instance list-vnics --instance-id "$INST" --query 'data[0]' 2>/dev/null)
SUBNET=$(echo "$VNIC" | grep -o '"subnet-id": "[^"]*"' | cut -d'"' -f4)
echo "── 공인 IP: $(echo "$VNIC" | grep -o '"public-ip": "[^"]*"' | cut -d'"' -f4)"

SUB=$(oci network subnet get --subnet-id "$SUBNET")
echo "── 서브넷: $(echo "$SUB" | grep -o '"display-name": "[^"]*"' | cut -d'"' -f4)"
if echo "$SUB" | grep -q '"prohibit-public-ip-on-vnic": true'; then
  echo "   ❌ 사설(Private) 서브넷입니다. 공용 서브넷으로 다시 만들어야 합니다. (원인 3)"
else
  echo "   ✅ 공용 서브넷입니다."
fi

RT=$(echo "$SUB" | grep -o '"route-table-id": "[^"]*"' | cut -d'"' -f4)
if oci network route-table get --rt-id "$RT" | grep -q 'internetgateway'; then
  echo "── 라우팅   ✅ 인터넷 게이트웨이 경로 있음"
else
  echo "── 라우팅   ❌ 인터넷 게이트웨이 경로가 없습니다. (원인 2)"
fi

SL=$(echo "$SUB" | grep -o '"security-list-ids": \[[^]]*\]' | grep -o 'ocid1[^"]*')
if oci network security-list get --security-list-id "$SL" | grep -q '"max": 22'; then
  echo "── 보안규칙 ✅ 22번 포트 인바운드 허용됨"
else
  echo "── 보안규칙 ❌ 22번 포트 규칙이 없습니다. (원인 1)"
fi
```

#### 원인별 해결

**원인 1 — Security List 에 22번 추가**
콘솔에서 Networking → VCN → 해당 서브넷 → Security List → **Add Ingress Rule**

| 항목 | 값 |
|---|---|
| Source Type | CIDR |
| Source CIDR | `0.0.0.0/0` |
| IP Protocol | TCP |
| Destination Port Range | `22` |

**원인 2 — 인터넷 게이트웨이 경로 추가**
Networking → VCN → **Internet Gateways** 에 게이트웨이가 없으면 먼저 만들고,
**Route Tables** → 해당 서브넷의 라우트 테이블 → **Add Route Rule**

| 항목 | 값 |
|---|---|
| Target Type | Internet Gateway |
| Destination CIDR | `0.0.0.0/0` |
| Target | 방금 만든 게이트웨이 |

**원인 3 — 사설 서브넷에 들어간 경우**
서브넷은 나중에 바꿀 수 없습니다. **인스턴스를 지우고 공용 서브넷으로 다시 만드세요.**
재시도 스크립트를 쓸 때 `oci network subnet list` 결과에서
이름에 **Public** 이 들어간 쪽의 OCID 를 골라야 합니다.

**그래도 안 되면 — 내 쪽 네트워크가 22번을 막는 경우**
회사·학교 와이파이는 아웃바운드 22번을 막기도 합니다.
휴대폰 핫스팟으로 바꿔서 한 번 시도해보면 바로 구분됩니다.
계속 막힌다면 Oracle 콘솔의 **Cloud Shell 에서 SSH** 하거나,
인스턴스 화면의 **Console Connection**(시리얼 콘솔)로 접속할 수 있습니다.

---

## 4. 서버 기본 세팅

### 시간대 맞추기 (꼭 하세요)

이 봇은 사진을 **날짜 폴더**에 저장합니다. 서버 시간대가 UTC면 한국시간 새벽에 올린 사진이
어제 폴더로 들어가서 헷갈립니다.

```bash
sudo timedatectl set-timezone Asia/Seoul
```

### 패키지 갱신 + Node.js 22 설치

```bash
sudo apt update && sudo apt -y upgrade
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git
```

설치 확인 (v22 이상, ARM이면 `arm64` 가 나와야 합니다):

```bash
node -v && npm -v && dpkg --print-architecture
```

### 스왑 만들기 — AMD 소형(1GB)을 쓸 때는 필수

ARM 6GB를 골랐다면 건너뛰어도 됩니다.
**AMD 1GB라면 이걸 안 하면 `npm install` 도중에 메모리 부족으로 죽습니다.**

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 5. 봇 코드 올리기

두 가지 방법이 있습니다. **다른 PC에서도 개발을 이어갈 계획이라면 A를 권합니다.**

### A. GitHub 비공개 저장소 (권장)

집 PC에서 먼저 GitHub에 비공개 저장소를 만들고 올립니다.

> ⚠️ `.env` 는 `.gitignore` 에 들어 있어 올라가지 않습니다. **절대 강제로 올리지 마세요.**
> 토큰이 노출되면 디스코드가 봇을 즉시 정지시킵니다.

집 PC(`C:\sarangbang-bot`)에서:

```bash
git init && git add -A && git commit -m "디스코드 봇 최초 커밋"
```

그다음 GitHub에서 **비공개(Private)** 저장소를 만들고, 안내에 나온 `git remote add` / `git push` 를 실행합니다.

서버에서 내려받습니다:

```bash
git clone https://github.com/<본인계정>/<저장소이름>.git sarangbang-bot && cd sarangbang-bot
```

### B. 파일 직접 전송 (git이 부담스러우면)

집 PC에서 실행합니다. `node_modules` 와 `bin` 은 서버에서 다시 만들 것이므로 보내지 않습니다.

```bash
scp -i ssh-key.key -r src scripts docs package.json package-lock.json verify.mjs .env.example ubuntu@<서버IP>:~/sarangbang-bot/
```

### 공통 — 의존성과 yt-dlp 설치

서버의 `~/sarangbang-bot` 안에서:

```bash
npm install && npm run update-ytdlp
```

`완료: /home/ubuntu/sarangbang-bot/bin/yt-dlp` 가 나오면 정상입니다. (ARM용을 알아서 받습니다)

---

## 6. `.env` 만들기

```bash
cp .env.example .env && nano .env
```

`nano` 편집기가 열립니다. 방향키로 이동해 값을 채우고, **Ctrl+O → Enter** 로 저장, **Ctrl+X** 로 나옵니다.

집 PC와 **반드시 달라져야 하는 값**은 다음과 같습니다.

```ini
# 리눅스 절대경로로 바꿉니다
IMAGE_DIR=/home/ubuntu/sarangbang-bot/data/images

# 갤러리를 이 서버 안에서만 열고, SSH 터널로 봅니다 (8단계 A안 — 권장)
WEB_BIND=127.0.0.1
WEB_PUBLIC_URL=http://localhost:3000

# 길고 아무 규칙 없는 문자열로 (아래 명령으로 만들 수 있습니다)
WEB_TOKEN=
```

`WEB_TOKEN` 에 넣을 무작위 문자열 만들기:

```bash
openssl rand -base64 32
```

나머지(`DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, 채널 ID들)는 집 PC의 `.env` 와 **똑같이** 넣으면 됩니다.

---

## 7. 동작 확인하고 실행

디스코드에 뭔가 등록하기 **전에** 자체 검사를 먼저 돌립니다. 실패하면 여기서 멈추고 원인을 보세요.

```bash
npm run verify
```

`✅ 전부 통과` 가 나오면 슬래시 명령어를 등록하고 봇을 켭니다.

```bash
npm run deploy
```

```bash
npm start
```

`✅ 로그인 완료: 봇이름#0000` 이 뜨면 성공입니다.
디스코드에서 `/핑` → `/재생` 순으로 확인해보세요. (README의 확인 순서 1~7단계 참고)

확인이 끝나면 **Ctrl+C** 로 일단 끕니다. 다음 단계에서 자동 실행으로 등록합니다.

---

## 8. 이미지 갤러리에 접속하는 방법 고르기

갤러리 웹페이지를 어떻게 볼지 결정해야 합니다. **A를 권합니다.**

### A. SSH 터널 (권장 — 포트를 인터넷에 열지 않음)

인터넷에 아무것도 노출하지 않으면서 내 브라우저로만 갤러리를 봅니다.
`.env` 에 `WEB_BIND=127.0.0.1` 을 넣었다면 이미 준비된 상태입니다.

내 PC에서 **터널을 연 채로** 두고:

```bash
ssh -i ssh-key.key -L 3000:localhost:3000 ubuntu@<서버IP>
```

그 상태에서 브라우저로 `http://localhost:3000` 을 엽니다.
디스코드의 `/갤러리` 명령이 알려주는 주소도 그대로 맞습니다.

- 장점: 포트를 열 필요가 없고, 통신이 SSH로 암호화됩니다. 함정 3을 통째로 피합니다.
- 단점: 갤러리를 볼 때마다 터널을 열어야 하고, 휴대폰에서 보기는 번거롭습니다.

### B. 포트를 인터넷에 여는 방법

휴대폰 등 아무 데서나 바로 접속하고 싶다면 이쪽입니다.
`.env` 를 이렇게 바꿉니다.

```ini
WEB_BIND=0.0.0.0
WEB_PUBLIC_URL=http://<서버IP>:3000
```

그리고 **방화벽 두 겹을 다 열어야 합니다** (함정 3).

**(1) 클라우드 쪽** — 수신 규칙(Ingress Rule) 추가

> 🔴 **보안목록이 여러 개입니다. 인스턴스가 실제로 들어있는 서브넷의 것에 넣어야 합니다.**
> VCN 마법사는 **공용(Public)** 과 **사설(Private)** 서브넷을 둘 다 만들고,
> 보안목록도 각각 따로 만듭니다. 사설 쪽에 규칙을 넣으면 **아무 효과가 없습니다.**
>
> 헷갈리지 않는 방법: **VCN 메뉴가 아니라 인스턴스에서 출발하세요.**
> Compute → Instances → 해당 인스턴스 → 아래 **Attached VNICs** →
> **Subnet** 링크 클릭 → 그 서브넷 화면의 **Security Lists** 에 있는 것을 고릅니다.
> SSH가 되고 있다면 그 서브넷이 공용 서브넷입니다.

고른 보안목록에서 **Add Ingress Rule**:

| 항목 | 값 |
|---|---|
| Stateless | 체크 안 함 (기본값) |
| Source Type | CIDR |
| Source CIDR | `0.0.0.0/0` (또는 내 집 IP만 넣으면 더 안전) |
| IP Protocol | TCP |
| Source Port Range | 비워둠 |
| Destination Port Range | `3000` |

> ⚠️ **Destination Port Range** 에 넣어야 합니다. Source Port 에 넣으면 동작하지 않습니다.

**(2) 서버 안쪽** — iptables 에도 구멍을 냅니다

OCI 우분투/오라클리눅스 이미지에는 **"나머지 전부 거부"** 규칙이 미리 들어 있습니다.

```
5    REJECT     0    --  0.0.0.0/0   0.0.0.0/0   reject-with icmp-host-prohibited
```

이 규칙 **위에** 허용 규칙을 넣어야 합니다. 아래에 넣으면 절대 적용되지 않습니다.
그리고 REJECT 가 몇 번째 줄인지는 이미지·버전마다 다르므로 **직접 찾아서** 넣습니다.

```bash
LINE=$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}'); if [ -n "$LINE" ]; then sudo iptables -I INPUT "$LINE" -p tcp --dport 3000 -j ACCEPT; else sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT; fi
```

제대로 들어갔는지 확인 — `dpt:3000` 줄이 `REJECT` 줄보다 **위에** 있어야 합니다.

```bash
sudo iptables -L INPUT -n --line-numbers | grep -E "3000|REJECT"
```

재부팅해도 유지되도록 저장합니다.

```bash
sudo netfilter-persistent save || (sudo apt install -y iptables-persistent && sudo netfilter-persistent save)
```

> 💡 `reject-with icmp-host-prohibited` 때문에 브라우저는 **`ERR_ADDRESS_UNREACHABLE`** 을 띄웁니다.
> 포트가 그냥 막혀 있을 때 나오는 `ERR_CONNECTION_TIMED_OUT` 과 다르므로 구분에 쓸 수 있습니다.

> ⚠️ **B를 고르면 감수해야 하는 것**
> - 통신이 HTTPS가 아니라 **평문**입니다. `WEB_TOKEN` 이 인터넷을 그대로 지나갑니다.
>   반드시 `openssl rand -base64 32` 로 만든 긴 문자열을 쓰세요.
> - 열린 포트는 자동 스캐너에 곧 발견됩니다.
> - 도메인이 있다면 Caddy 같은 리버스 프록시로 HTTPS를 붙이는 게 훨씬 낫습니다.
>   (이 문서 범위 밖이지만, 필요해지면 그때 찾아보세요)

---

## 9. 24시간 자동 실행 등록 (systemd)

`npm start` 는 SSH를 끊으면 같이 죽습니다. 서버가 재부팅돼도 알아서 살아나도록 등록합니다.

봇이 둘이므로 **서비스도 둘**입니다.

| 봇 | 서비스 이름 |
|---|---|
| 망고 (읽어주기·타이머·이미지) | `sarangbang-bot` |
| 노래하는 망고 (음악) | `music-sarangbang-bot` |

### 9-1. 망고

```bash
sudo tee /etc/systemd/system/sarangbang-bot.service > /dev/null <<'EOF'
[Unit]
Description=Mango (TTS + timer + images)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/sarangbang-bot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

등록하고 시작합니다.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now sarangbang-bot
```

상태 확인:

```bash
sudo systemctl status sarangbang-bot
```

`active (running)` 이면 성공입니다. 이제 SSH를 끊어도 봇은 계속 돕니다.

### 9-2. 노래하는 망고 (음악을 쓸 때만)

`.env.music` 을 먼저 만들어 두세요 (README 5단계).
`--env-file` 로 그 파일을 읽는 것 말고는 위와 같습니다.

```bash
sudo tee /etc/systemd/system/music-sarangbang-bot.service > /dev/null <<'EOF'
[Unit]
Description=Singing Mango (music)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/sarangbang-bot
ExecStart=/usr/bin/node --env-file=.env.music src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now music-sarangbang-bot
```

```bash
sudo systemctl status music-sarangbang-bot
```

> 💡 **둘은 따로 재시작합니다.** 음악을 고쳐도 읽어주기는 안 끊깁니다.
> 로그도 따로 봅니다: `journalctl -u music-sarangbang-bot -f`

---

## 10. 유튜브가 "봇 아니냐"고 막을 때

**Oracle은 데이터센터 IP라서 거의 반드시 막힙니다.** 실제로 이 프로젝트에서 확인했습니다.

증상이 여러 얼굴로 나타나므로 헷갈리기 쉽습니다 — 아래는 **전부 같은 원인**입니다.

- `유튜브가 이 서버를 봇으로 판단해 차단했습니다`
- `유튜브가 일시적으로 요청을 거부했습니다` 가 **반복될 때**
- verbose 로 보면 `playability status: LOGIN_REQUIRED`

**확인 명령**

```bash
cd ~/sarangbang-bot && ./bin/yt-dlp --simulate -v "https://www.youtube.com/watch?v=wp43OdtAAkM" 2>&1 | grep -E "LOGIN_REQUIRED|Sign in|ERROR"
```

**해결: 브라우저 쿠키를 서버에 넣어줍니다.**

1. 집 PC 브라우저에서 유튜브에 로그인한 상태로, `Get cookies.txt LOCALLY` 같은
   확장 프로그램으로 `cookies.txt` 를 저장합니다
2. 서버로 보냅니다 (집 PC에서 실행):

   ```bash
   scp -i ssh-key.key cookies.txt ubuntu@<서버IP>:~/sarangbang-bot/cookies.txt
   ```

3. 서버의 `.env` 에 경로를 적습니다:

   ```ini
   YTDLP_COOKIES_FILE=/home/ubuntu/sarangbang-bot/cookies.txt
   ```

4. 봇을 재시작합니다:

   ```bash
   sudo systemctl restart sarangbang-bot
   ```

> 🔒 **이 파일은 본인 유튜브 계정의 로그인 정보입니다.**
> 남에게 주지 말고, git에 올리지 마세요. (`.gitignore` 에 `cookies.txt` 를 추가해두면 안전합니다)
>
> 쿠키는 시간이 지나면 만료됩니다. 다시 막히면 위 과정을 반복하세요.

---

## 11. 평소 관리

### 로그 보기

```bash
journalctl -u sarangbang-bot -f              # 망고
journalctl -u music-sarangbang-bot -f        # 노래하는 망고
```

`-f` 는 실시간으로 계속 보여줍니다. **Ctrl+C** 로 빠져나옵니다.
최근 100줄만 보려면:

```bash
journalctl -u sarangbang-bot -n 100 --no-pager
```

### 음악이 안 나올 때 (1순위 조치)

음악은 `music-sarangbang-bot` 쪽입니다. 망고는 건드릴 필요 없습니다.

```bash
cd ~/sarangbang-bot && npm run update-ytdlp && sudo systemctl restart music-sarangbang-bot
```

### 코드를 고친 뒤 반영하기

저장소는 하나라서 `git pull` 은 한 번이지만, **서비스는 둘 다** 재시작해야 합니다.

```bash
cd ~/sarangbang-bot && git pull && npm install && npm run verify && sudo systemctl restart sarangbang-bot music-sarangbang-bot
```

명령어를 추가·수정했다면 등록도 **봇마다** 해야 합니다.
`deploy` 는 덮어쓰기라, 한쪽만 하면 다른 쪽 명령어는 그대로 남습니다.

```bash
cd ~/sarangbang-bot && npm run deploy && npm run deploy:music
```

### 디스크 감시 — 이건 직접 챙기셔야 합니다

이 봇은 **사진 중복 검사를 하지 않습니다.** 같은 사진을 두 번 올리면 두 번 저장되고,
`data/images` 는 계속 커지기만 합니다. 디스크가 차면 봇이 조용히 실패합니다.

남은 용량 확인:

```bash
df -h /
```

어느 폴더가 큰지 확인:

```bash
du -sh ~/sarangbang-bot/data/images/* | sort -h | tail -20
```

### 백업해둘 것

서버가 회수되거나 날아가도 다시 만들 수 있게, 아래만은 따로 보관하세요.

- `.env` (토큰과 설정)
- `data/` 폴더 전체 (모아둔 사진 + `/채널설정` 으로 지정한 설정)
- SSH 개인키

집 PC로 사진과 설정을 통째로 가져오려면 (집 PC에서 실행):

```bash
scp -i ssh-key.key -r ubuntu@<서버IP>:~/sarangbang-bot/data ./data-backup
```

---

## 12. 문제가 생겼을 때

| 증상 | 원인과 해결 |
|---|---|
| 인스턴스 생성 시 `Out of host capacity` | ARM 자리 부족. **함정 1** 참고 — 한국 리전은 AD가 1개라 "다른 AD" 는 불가. AMD로 먼저 시작하거나 재시도 스크립트를 걸 것 |
| 재시도 스크립트가 용량 외 에러로 멈춤 | ID(이미지/서브넷/AD)를 잘못 넣었을 가능성. 출력된 에러 내용 확인 |
| SSH 접속 시 `Permission denied` | 키 파일 권한. `chmod 600 ssh-key.key` |
| SSH 접속 시 `Connection timed out` | 방화벽/라우팅 문제. **3단계의 진단 스크립트**를 돌려보세요 |
| SSH 접속 시 `Connection refused` | 서버까지는 닿음. 인스턴스가 아직 부팅 중일 수 있으니 1~2분 뒤 재시도 |
| `npm run verify` 실패 | 파일이 덜 올라갔거나 `npm install` 미실행 |
| `n challenge solving failed` | JS 런타임 없음. `.env` 의 `YTDLP_JS_RUNTIME=false` 를 지우고 재시작 |
| `.env` 를 고쳤는데 반영 안 됨 | 같은 항목이 여러 줄일 수 있습니다. 봇 시작 로그의 "중복된 항목" 경고 확인 |
| 갤러리 `ERR_ADDRESS_UNREACHABLE` | 서버 안 `iptables` 의 `reject-with icmp-host-prohibited` 에 막힌 것. 8단계 (2) 참고. (주소에 사설 IP(10.x)를 넣은 경우에도 같은 에러) |
| 갤러리 `ERR_CONNECTION_TIMED_OUT` | 클라우드 쪽 **보안목록**이 안 열린 것. 8단계 (1) 참고 |
| `Access denied` / 비밀번호를 물어봄 | `systemctl` 앞에 **`sudo`** 를 빼먹었습니다. OCI 이미지의 ubuntu 계정은 비밀번호가 없어서 반드시 sudo 로 실행해야 합니다 |
| 봇이 켜지자마자 죽음 | `journalctl -u sarangbang-bot -n 50` 확인 (음악은 `music-sarangbang-bot`). 대개 `.env` 값 문제 |
| 모든 명령에 봇이 **두 번** 답함 | `.env` 와 `.env.music` 의 토큰이 같습니다. 애플리케이션을 따로 만드세요 (봇이 잡아내고 실행을 멈춥니다) |
| 갤러리 접속 안 됨 (B안) | 방화벽 두 겹 중 하나만 열었을 가능성 (함정 3) |
| 갤러리 접속 안 됨 (A안) | SSH 터널 창을 닫았거나, `.env` 의 `WEB_BIND` 가 `127.0.0.1` 인지 확인 |
| 사진이 어제 날짜 폴더에 들어감 | 서버 시간대가 UTC. `sudo timedatectl set-timezone Asia/Seoul` 후 재시작 |
| 서버가 통째로 사라짐 | 유휴 회수 (함정 2). PAYG 전환을 고려하세요 |
| 음악만 안 됨 | `npm run update-ytdlp` → 그래도 안 되면 10절 쿠키 설정 |
| 메모리 부족으로 죽음 (AMD 1GB) | 4단계의 스왑 파일 생성 |

---

## 참고 자료

- [Oracle Always Free 자원 한도 (공식)](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [유휴 인스턴스 회수 정책 논의](https://lowendtalk.com/discussion/184161/oracle-may-reclaim-your-idle-vps)
- 이 프로젝트의 설계 문서: [ARCHITECTURE.md](ARCHITECTURE.md) (10절에 이전 체크리스트 요약)
- 봇 사용법과 최초 설정: [README.md](../README.md)
