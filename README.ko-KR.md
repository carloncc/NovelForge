<div align="center">

<img src="docs/logo.png" width="96" alt="NovelForge" />

# NovelForge

**한 번의 클릭, 소설이 비주얼 노벨로.**

글로만 읽기엔 아쉽다, 그림이 있어야 몰입이 된다. 원클릭으로 소설을 플레이 가능한 비주얼 노벨로 변환——입화·표정·CG·음성·BGM·분기를 전부 자동 생성. 미리보기, 패키징(exe / APK / 웹), 배포까지 한 번에.

<p>
  <a href="https://github.com/carloncc/NovelForge/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/carloncc/NovelForge?color=blue"></a>
  <a href="https://github.com/carloncc/NovelForge/releases"><img alt="Release" src="https://img.shields.io/github/v/release/carloncc/NovelForge"></a>
  <a href="https://github.com/carloncc/NovelForge/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/carloncc/NovelForge"></a>
  <a href="https://github.com/carloncc/NovelForge/issues"><img alt="Issues" src="https://img.shields.io/github/issues/carloncc/NovelForge"></a>
  <a href="https://www.forgepeaknow.com/?utm_source=github&utm_medium=readme&utm_content=ko-kr"><img alt="Website" src="https://img.shields.io/badge/Website-forgepeaknow.com-64748b"></a>
</p>
Tauri 2 + Vue 3 + WebGAL · 가볍고 빠름 · API 완전 커스터마이즈

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · **한국어** · [공식 사이트](https://www.forgepeaknow.com/?utm_source=github&utm_medium=readme&utm_content=ko-kr) · [변경 로그](https://github.com/carloncc/NovelForge/releases)

</div>

---

<details>
<summary><kbd>📑 목차</kbd></summary>

- [왜 NovelForge인가?](#왜-novelforge인가)
- [원클릭, 완료](#원클릭-완료)
- [빠른 시작](#빠른-시작)
- [NovelForge를 쓰면 안 되는 경우](#novelforge를-쓰면-안-되는-경우)
- [기능](#기능)
- [스크린샷](#스크린샷)
- [API 설정 예시](#api-설정-예시)
- [비주얼 바이블(이미지 생성 게이트)](#비주얼-바이블이미지-생성-게이트)
- [웹 모드(브라우저에서 직접 실행, 빌드 불필요)](#웹-모드브라우저에서-직접-실행-빌드-불필요)
- [유니버설 어댑터(이미지 / TTS)](#유니버설-어댑터이미지--tts)
- [출력 구조(표준 WebGAL 프로젝트)](#출력-구조표준-webgal-프로젝트)
- [개발 및 테스트](#개발-및-테스트)
- [아키텍처](#아키텍처)
- [커뮤니티](#커뮤니티)
- [기여](#기여)
- [면책 조항](#면책-조항)
- [크레딧 및 라이선스](#크레딧-및-라이선스)
- [Roadmap](#roadmap)

</details>

## 왜 NovelForge인가?

| | 이유 |
|---|---|
| 🪄 **원클릭, 수작업 제로** | 비주얼 노벨을 직접 만들려면 입화 제작, 연출 구성, 음성 녹음이 필요합니다. NovelForge는 이를 모두 자동화합니다: 소설 가져오기 → 생성 버튼 → 플레이 가능하고 배포 가능한 완성품 |
| 🎬 **읽는 것이 아니라 보는 것** | 이야기는 글로도 전달되지만, 표정 있는 캐릭터, 장면 CG, 음성, BGM은 텍스트만으로는 얻을 수 없는 몰입을 제공합니다——모두 자동 생성되어 수작업 화면 제작이 필요 없습니다 |
| 🔥 **누구도 각색하지 않는 소설을 위해** | 인기작은 각색·번역되지만, 마이너한 소설은 그 어느 것도 얻기 어렵습니다. NovelForge는 바로 이 간극을 노립니다: 니치한 이야기를 공유 가능한 비주얼 노벨로. 다국어 번역(중/영/일/한) 내장 |

## 원클릭, 완료

```
소설.txt ─▶ 원클릭 ─▶ 입화 · 표정 · CG · 배경 ─▶ 음성 · BGM ─▶ 플레이 가능한 비주얼 노벨
   AI 파이프라인: 분할 → 번역 → 추출 → 시나리오 → 이미지 → 음성 → 조립    └─▶ 미리보기 / exe / APK / 웹 zip
```

> API 키는 직접 준비하세요(키가 없으면? 샘플 소설 내장 데모 모드로 전체 과정이 동작합니다). 이미지 활성 시 일괄 생성 전에 스타일 확인(비주얼 바이블)이 한 번 필요합니다.

## 빠른 시작

### 앱 다운로드

<p align="center">
  <a href="https://github.com/carloncc/NovelForge/releases/latest"><img alt="Windows" src="https://img.shields.io/badge/Windows-exe-4c1d95?style=for-the-badge&logo=windows"></a>
  <a href="https://github.com/carloncc/NovelForge/releases/latest"><img alt="macOS" src="https://img.shields.io/badge/macOS-dmg-1f2937?style=for-the-badge&logo=apple"></a>
  <a href="https://github.com/carloncc/NovelForge/releases/latest"><img alt="Linux" src="https://img.shields.io/badge/Linux-AppImage-0ea5e9?style=for-the-badge&logo=linux"></a>
</p>

| 플랫폼 | 받는 방법 |
|---|---|
| Windows / macOS / Linux | [최신 릴리스](https://github.com/carloncc/NovelForge/releases)(Rust/Node 설치 불필요) |
| 모든 플랫폼(브라우저) | Web 데모——설치 없이 브라우저에서 바로 실행(아래 참조) |
| 공식 사이트 | [https://www.forgepeaknow.com/?utm_source=github&utm_medium=readme&utm_content=ko-kr](https://www.forgepeaknow.com/?utm_source=github&utm_medium=readme&utm_content=ko-kr) —— 웹 데모 및 최신 소식 |

> API 키 없이도 체험 가능: 자동으로 데모 모드(샘플 소설 내장)로 진입해 전체 과정이 동작합니다——설정 전에 먼저 시도해 보세요.

### Web 데모 실행(설치 불필요·빌드 불필요)

```bash
git clone git@github.com:carloncc/NovelForge.git
cd NovelForge
pnpm install
pnpm prepare:template   # WebGAL 엔진 템플릿 다운로드(최초 1회, 약 75MB, 자동 정리)
npm run dev             # 브라우저에서 http://localhost:5173 열기
```

### 데스크톱 개발 실행

```bash
pnpm tauri dev
```

요구 사항: Node.js 18+ · pnpm · Rust(https://rustup.rs) · Windows / macOS / Linux.

### 빌드 및 패키징

```bash
pnpm tauri build
```
산출물은 `src-tauri/target/release/bundle/`(Windows exe / macOS dmg / Linux AppImage).

### 사용 흐름

1. **소설 가져오기**: txt 선택(GBK/UTF-8 자동 감지), 챕터 자동 분할. 여러 파일과 LLM 스마트 분할 지원. 커스텀 소재 임포트 가능
2. **API 설정**: 텍스트 LLM의 base_url + key + model 입력(DeepSeek이 가장 저렴, 약 ¥1-2/백만 토큰). 이미지/TTS/비전은 나중에 추가 가능(이미지 생성 전에 이미지 채널 설정 필요)
3. **생성**: 기능 토글(이미지/표정 차분/음성/영상 슬롯/BGM/소개 카드) → 시작 → 텍스트 단계가 먼저 진행. 이미지 활성 시 먼저 **비주얼 바이블 승인**(스타일 소스 선택 → 삼면도 생성/확인 → 승인) → 승인 후 이미지/음성/조립 진행 → 진행 로그 + 비용 통계. 단계별 재생성과 AI 챕터 분할 피드백 지원
4. **미리보기**: 내장 WebGAL 엔진으로 즉시 플레이
5. **내보내기**: 웹 zip은 직접 배포. exe/APK는 생성된 '导出说明.txt' 안내에 따름

## NovelForge를 쓰면 안 되는 경우

- 특정 작가의 픽셀 완벽한 아트가 필요한 경우: 생성 입화는 AI 아트——개인 프로젝트엔 좋지만 상업용 아트 디렉션엔 부적합합니다.
- 텍스트 리더(화면 없음)만 원하는 경우: 이건 비주얼 노벨 파이프라인이지 전자책 리더가 아닙니다.
- AI 비용을 전혀 감당할 수 없는 경우: 생성은 본인 키로 벤더 API를 호출합니다(데모 모드는 무료지만 샘플 프로젝트만 생성).

## 기능

| | 설명 |
|---|---|
| 📖 **올인원 파이프라인** | 챕터 분할 → 다국어 번역 → 카드 추출 → 시나리오(자동 CG 연출·아이템 클로즈업·첫 등장 소개 카드·영상 슬롯) → 이미지 → 음성 → 표준 WebGAL 조립 |
| 🎨 **배경 없는 입화** | 자동 컷아웃(AI 세그멘테이션, 첫 사용 시 모델 자동 다운로드·캐시. 오프라인 시 개선된 크로마키로 자동 폴백: 연결 flood-fill + 녹색 테두리 제거 + 가장자리 페더링) |
| 🎨 **화풍 일관성** | 프로젝트 전체 '스타일 앵커 이미지' + 고정 시드 + 공통 네거티브 프롬프트 + 체인 img2img(삼면도 → 입화 → 표정/동작), 멀티모달 자체 검사로 참조 이미지와 캐릭터 일치 확인 |
| 📖 **비주얼 바이블 게이트** | 이미지 일괄 생성 전 '비주얼 바이블' 승인이 필수: 스타일 소스 선택(업로드한 참조 이미지를 비전 채널이 분석 / LLM이 소설 전체 분석 후 스타일 샘플 생성) + 주인공별 삼면도(정면/측면/후면). 특정 캐릭터의 삼면도만 재생성 가능하며 다른 캐릭터에 영향 없음. 입력이 바뀌면 승인은 자동 무효화 |
| 😊 **표정 차분** | 캐릭터당 5가지 표정 입화(normal 이미지를 참조로 일관성 유지), 대사 감정에 따라 자동 전환 |
| 🏃 **동작 입화** | 삼면도 기반 img2img로 동작 입화(검 뽑기·손 흔들기·팔짱 등) 생성, 외형 일관성 유지 |
| 🔀 **분기 선택** | LLM이 결정 지점을 감지해 2~3개의 선택지를 생성, 각 분기는 본선으로 합류(WebGAL choose/label/jumpLabel) |
| 🎬 **챕터 타이틀 카드** | 각 챕터 시작 시 전체 화면 타이틀 연출 |
| ✨ **연출 강화** | 명장면은 전체 CG, 중요 아이템은 클로즈업 연출, 첫 등장 캐릭터는 소개 카드 |
| 🎬 **영상 슬롯** | AI가 명장면 위치를 표시하고 영상 프롬프트 생성. 지정 파일명으로 영상(지메이/클링 등)을 넣으면 자동 활성화(API 비용 0) |
| 🎙️ **음성 + 음색 제어** | 문장 단위 TTS, 음색 라이브러리 설정 가능, AI가 캐릭터에 맞는 음색 자동 선택, 실패 시 자동 폴백 |
| 🎵 **BGM** | 음악 파일을 분위기 키워드로 자동 매칭, 장면/챕터 전환 시 자동 페이드아웃, BGM 감상 잠금 해제 |
| 🌐 **UI 5개 언어** | 앱 인터페이스가 시스템 언어를 자동 감지(간체/번체/영어/일어/한국어), 언제든 전환 가능——소설 콘텐츠와 게임 번역은 '목표 언어'로 별도 제어. |
| 🔌 **API 완전 커스터마이즈** | LLM/비전/이미지/TTS 4개 채널 각각 base_url + api_key + model(OpenAI 호환 프로토콜), 다중 프리셋 + 테스트 버튼. 이미지 채널은 모델별 능력(참조 이미지 수/img2img/시드) 설정·자동 탐지 |
| 🗂️ **소재 우선** | 캐릭터/아이템/배경 이미지 임포트 + 수동 매핑 지원. 파이프라인은 기존 소재를 우선 사용하고 부족한 것만 AI 생성 |
| ♻️ **비용 관리** | 전 단계 디스크 캐시, 중단점 재개, 챕터 단위 재실행, 중단 버튼, 토큰/비용 통계, 예산 상한(초과 시 자동 중단), 실패 태스크 목록과 재시도, 로그 저장 |
| 💾 **상태 영속화** | 소설/소재/옵션/결과 자동 저장. AI 챕터 분할 스냅샷으로 재시작해도 챕터 유지. 최근 프로젝트 이력 원클릭 전환 |
| 📦 **3종 내보내기** | 웹 zip(캐시 자동 제외)/내보내기 전 검사(Lint)/내보내기 설정(제목·game_key·UI 언어)/PC exe(WebGAL Terre)/Android APK(공식 도구) |
| 🔒 **보안** | LLM 출력 인젝션 방어, CSP, 의존성 감사에서 알려진 CVE 0건 |

## 스크린샷

## 스크린샷

### 생성된 게임(샘플 소설, WebGAL 엔진에서 실제 실행 중)

| 타이틀 화면 | 스토리 장면 | 명장면 CG |
|---|---|---|
| ![Game title](docs/screenshots/game-title.png) | ![Game story](docs/screenshots/game-story.png) | ![Game CG](docs/screenshots/game-cg.png) |

### NovelForge 앱

| 소설 가져오기 | API 설정 | 생성 |
|---|---|---|
| ![Import](docs/screenshots/import.png) | ![Config](docs/screenshots/config.png) | ![Generate](docs/screenshots/generate.png) |

| 내보내기 | 비주얼 바이블 |
|---|---|
| ![Export](docs/screenshots/export.png) | ![Visual Bible](docs/screenshots/visual-bible-novel_analysis-1280.png) |

## API 설정 예시

| 서비스 | 채널 | Base URL | 모델 예시 |
|---|---|---|---|
| DeepSeek | LLM | `https://api.deepseek.com` | `deepseek-chat` |
| SiliconFlow | 비전 | `https://api.siliconflow.cn/v1` | `zai-org/GLM-4.6V` |
| SiliconFlow | 이미지(참조 이미지) | `https://api.siliconflow.cn/v1` | `Qwen/Qwen-Image-Edit-2509` |
| SiliconFlow | 이미지 | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| SiliconFlow | TTS | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` |
| OpenAI | LLM | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi | LLM | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama(로컬) | LLM | `http://localhost:11434/v1` | `qwen2.5:7b` |

**비전 채널**: 이미지를 '읽는' 모든 작업(스타일 참조 이미지 분석, 캐릭터 참조 검증, 이미지 자체 검사)을 담당하며 텍스트 LLM과 독립적입니다. 신규 설정은 비전에 SiliconFlow `zai-org/GLM-4.6V`, 이미지에 `Qwen/Qwen-Image-Edit-2509`(참조 이미지 최대 3장/img2img)가 기본값입니다. 기존 3채널 구성은 최초 로드 시 자동 마이그레이션됩니다.

## 비주얼 바이블(이미지 생성 게이트)

이미지 생성이 활성화되면 일괄 생성 전에 **비주얼 바이블** 승인이 필수입니다(텍스트 추출/시나리오는 영향 없음):

- **스타일 소스(택1)**: 참조 이미지 업로드(비전 채널이 분석해 글로벌 스타일 참조로 사용), 또는 LLM이 소설 전체를 분석해 캐릭터 없는 스타일 샘플 생성.
- **캐릭터 삼면도**: 주인공별 정면/측면/후면 생성. 개별 '삼면도 재생성' 가능, 캐릭터 참조 이미지 업로드 가능. 해당 캐릭터에만 영향.
- **승인 및 계속**: 캐릭터별 확인 → 비주얼 바이블 승인 → 이미지/음성/조립 자동 재개. 소설·캐릭터·스타일이 바뀌면 승인 무효화.
- **조용한 폴백 없음**: 참조 이미지 미지원 모델은 `REFERENCE_UNSUPPORTED`, 참조 파일 누락은 `REFERENCE_MISSING`을 명시. 비전 채널 미설정 시 명확한 설정 안내.

**저장 위치**: 프로젝트 출력 디렉터리 `.novel2vn/visual-bible/` 아래 전부 저장(매니페스트 `visual-bible.json`은 상대 경로/프롬프트/승인 상태만 저장, base64 미포함. 이미지는 `style-reference.*`, `style-sample.png`, `threeview_<캐릭터ID>.png` 등). 참조 파일 누락 안내는 보통 디렉터리가 이동·삭제된 경우입니다: 원래 경로에 복원하거나 비주얼 바이블 화면에서 재업로드/재생성하면 됩니다.

## 웹 모드(브라우저에서 직접 실행, 빌드 불필요)

```bash
npm run dev          # 또는 pnpm dev, 브라우저에서 http://localhost:5173 열기
```

웹 버전은 데스크톱과 동일한 기능을 브라우저 네이티브 구현으로 제공합니다:

| 데스크톱(Tauri) | 웹 모드 |
|---|---|
| 로컬 파일시스템 | IndexedDB 가상 파일시스템(브라우저에 영속화) |
| Rust HTTP 클라이언트(CORS 제한 없음) | dev 서버 프록시 중계(`/__novelforge/proxy`) |
| 내장 미리보기 서버 | 프론트가 zip 업로드 → dev 서버가 압축 해제·제공(동일 출처 iframe) |
| Rust rembg 컷아웃 | canvas 연결 flood-fill 크로마키(흰/검은 배경 자동 제거) |
| 번들된 WebGAL 엔진 템플릿 | `src-tauri/templates/webgal`을 IndexedDB로 온디맨드 동기화 |
| 네이티브 파일 다이얼로그 | 브라우저 `<input type="file">` |
| zip을 디스크에 저장 | 내보내기 zip 자동 다운로드 |

> 프로덕션: `npm run build` + `npm run preview`(preview 서버도 동일한 프록시/미리보기 미들웨어 제공, 리버스 프록시 가능).
> 백엔드 없는 정적 호스팅 시 브라우저 직접 연결로 폴백(벤더가 CORS 지원 필요).

## 유니버설 어댑터(이미지 / TTS)

벤더별 이미지/음성 프로토콜은 크게 다릅니다(OpenAI 호환 / MiniMax 독자 / Alibaba 태스크 폴링).
NovelForge는 **설정 기반 유니버설 어댑터 엔진**(`sync`/`async` 모드 + 필드 매핑 템플릿)을 내장합니다. 설정 화면의 '벤더 템플릿'에서 원클릭 선택:

| 벤더 | 이미지 | TTS |
|---|---|---|
| OpenAI 호환(Zhipu CogView / OpenAI) | ✅ openai-image | ✅ openai-tts |
| SiliconFlow(FLUX, 권장) | ✅ siliconflow-image(시드/네거티브/img2img 완전 지원) | ✅ openai-tts |
| MiniMax(image-01 / speech-2.8) | ✅ minimax-image | ✅ minimax-tts(HEX 자동 디코드) |
| Alibaba DashScope(wanx-v1 / CosyVoice) | ✅ dashscope-image(태스크 폴링, 시드/네거티브 지원) | ✅ dashscope-tts |

그 외 **Google Gemini**(`/v1beta/models/{model}:generateContent`, inlineData 자동 추출)와
**Stability AI**(multipart/form-data + 원시 바이너리 응답) 내장. 엔진은 벤더별 오류 본문(`base_resp` / `error.message` / `output.message` 등)을 자동 파싱해 읽기 쉬운 메시지로 변환합니다.

새 벤더는 '고급 → 커스텀 어댑터 템플릿'에 JSON을 붙여넣기만 하면 코드 수정 없이 연결 가능.
참조 이미지 능력(0~3장, img2img, 시드)은 이미지 채널에서 모델별 설정·자동 탐지. 능력 부족이나 참조 파일 누락 시 명시적으로 오류를 내며 조용히 텍스트→이미지로 폴백하지 않습니다.

## 출력 구조(표준 WebGAL 프로젝트)

```
출력 디렉터리/
├─ index.html, assets/          # WebGAL 엔진(내장)
├─ 导出说明.txt                 # exe/APK/웹 zip 내보내기 안내
├─ video_plan.txt               # AI 생성 영상 슬롯 목록(프롬프트)
└─ game/
   ├─ config.txt                # 게임 설정
   ├─ scene/start.txt, ch*.txt  # 시나리오(텍스트로 직접 편집 가능)
   ├─ background/  figure/  vocal/  bgm/  video/
   └─ .novel2vn/                # 캐시 및 중간 산출물(삭제 가능)
      └─ visual-bible/          # 비주얼 바이블: 매니페스트 + 스타일 참조 + 삼면도
```

## 개발 및 테스트

```bash
# 유닛 & E2E 테스트(Node)
npx tsx tests/unit-render.ts      # 렌더링 주입 경계
npx tsx tests/unit-chapters.ts    # 챕터 분할 경계
npx tsx tests/unit-cache.ts       # 캐시/재개 일관성
npx tsx tests/unit-tasks.ts       # 이미지 태스크 구성
npx tsx tests/unit-material.ts    # 소재 우선 매칭
npx tsx tests/unit-features.ts    # 소개 카드/표정/BGM/영상 슬롯
npx tsx tests/unit-persist.ts     # 상태 영속화
npx tsx tests/unit-retry.ts       # API 재시도 메커니즘
npx tsx tests/unit-dedupe.ts      # 장면 id 중복 제거
npx tsx tests/unit-universal.ts   # 유니버설 어댑터 엔진(전 벤더 템플릿)
npx tsx tests/unit-vfs.ts         # IndexedDB 가상 파일시스템
npx tsx tests/e2e-demo.ts         # E2E 파이프라인(샘플 소설)

# 실엔진 검증(헤드리스 브라우저로 생성 게임 로드)
npx tsx tests/engine-check.ts <프로젝트 디렉터리>

# Rust 측 테스트(크로마키 컷아웃)
cd src-tauri && cargo test
```

## 아키텍처

```
┌────────────────────────────────────────────┐
│  NovelForge(Tauri 2 + Vue 3 + TypeScript)  │
│  ├─ pages: 가져오기 / 설정 / 생성 /         │
│  │          미리보기 / 내보내기              │
│  ├─ core:  split → translate → extract →   │
│  │          script → images → voice →      │
│  │          render → project               │
│  ├─ api:   OpenAI 호환 어댑터              │
│  │          (LLM / 비전 / 이미지 / TTS)     │
│  └─ Rust:  파일 IO / HTTP 중계 / 미리보기   │
│            서버 / 크로마키 컷아웃 / 설정 저장│
└───────────────┬────────────────────────────┘
                ▼ 표준 WebGAL 프로젝트
┌────────────────────────────────────────────┐
│  WebGAL 엔진(MPL-2.0, 소스 미변경)          │
│  미리보기(내장) / exe(Terre) /              │
│  APK(공식 도구)                            │
└────────────────────────────────────────────┘
```

## 커뮤니티

- [공식 사이트](https://www.forgepeaknow.com/?utm_source=github&utm_medium=readme&utm_content=ko-kr) —— 웹 데모 및 최신 소식
- [Issues & 기능 요청](https://github.com/carloncc/NovelForge/issues) —— 버그 제보, 아이디어, 피드백
- [Discussions](https://github.com/carloncc/NovelForge/discussions) —— 만든 게임 자랑하기, 질문하기
- [WebGAL](https://github.com/OpenWebGAL/WebGAL) —— 엔진 본체. WebGAL 커뮤니티가 씬 스크립트에 정통합니다

[![Star History](https://api.star-history.com/svg?repos=carloncc/NovelForge&type=Date)](https://star-history.com/#carloncc/NovelForge&Date)

만든 비주얼 노벨을 공개하세요——그것이 이 도구의 존재 이유입니다.

## 기여

버그 제보, 기능 제안, 번역, 코드 등 모든 형태의 기여를 환영합니다.

- 버그 제보·기능 요청: [Issues](https://github.com/carloncc/NovelForge/issues)
- 토론: [Discussions](https://github.com/carloncc/NovelForge/discussions)
- 코드 변경 시 PR 전에 테스트를 실행하세요([개발 및 테스트](#개발-및-테스트) 참조)

**주요 관리자:** [@carloncc](https://github.com/carloncc)

## 면책 조항

이 소프트웨어는 '있는 그대로' 제공되며 어떠한 보증도 없습니다. NovelForge를 사용함으로써 귀하는 다음을 인지하고 동의한 것으로 간주됩니다:

- **생성 콘텐츠에 대한 책임은 전적으로 귀하에게 있습니다**: 본 도구가 생성한 모든 AI 콘텐츠(이미지·음성·시나리오)와 그 사용·게시·배포 방식에 대한 책임은 귀하에게 있습니다. 저자는 모델 출력을 통제할 수 없으며 이에 대한 책임을 지지 않습니다.
- **권리가 있는 콘텐츠만 사용하세요**: 소유했거나 각색 권한이 있는 소설만 불러오십시오. 생성 결과는 설정한 AI 서비스 제공업체의 이용 약관에 따라 달라질 수 있습니다.
- **제3자 API 비용과 약관은 본인 책임입니다**: NovelForge는 귀하가 설정한 키로 제공업체를 호출합니다. 사용량과 청구는 직접 모니터링하세요.
- **불법·권리 침해 콘텐츠를 생성하지 마세요**: 저작권 보호 캐릭터, 실존 인물의 초상, 증오·유해 콘텐츠를 포함합니다. 관련 법률과 플랫폼 정책 준수는 귀하의 책임입니다.
- **필수 저작자 표시 유지**: NovelForge로 게시하는 작품에는 WebGAL 저작권 고지를 남겨야 합니다([LICENSE](./LICENSE) 참조).

## 크레딧 및 라이선스

- [WebGAL](https://github.com/OpenWebGAL/WebGAL) — 비주얼 노벨 엔진(MPL-2.0), [THIRD_PARTY_NOTICE](./THIRD_PARTY_NOTICE) 참조
- NovelForge 본체는 [MIT](./LICENSE) 라이선스
- 게시물에는 WebGAL 저작권 표시를 유지해야 합니다. 게임 콘텐츠 저작권은 창작자에게 귀속됩니다

## Roadmap

- [x] 화풍 일관성: 스타일 앵커 + 고정 시드 + 네거티브 프롬프트 + 체인 img2img
- [x] 분기 선택(choose/jumpLabel, LLM이 결정 지점 자동 표시)
- [x] 챕터 타이틀 카드 / 타이틀 화면(Title_img/Title_bgm) / BGM 자동 페이드아웃·감상 잠금 해제
- [x] 비주얼 바이블 게이트: 스타일 참조 + 캐릭터 삼면도 + 승인 플로우
- [x] 단계별 생성 + 피드백(AI 챕터 분할) / 다중 파일 임포트 / 다국어 번역
- [ ] 표정 차분 img2img 강화(표정·의상 차분 추가)
- [ ] AI 음악 생성 채널(BGM 완전 자동화)
- [ ] 전환 애니메이션(배경 전환 효과)
- [ ] 게임 내 캐릭터 도감
- [ ] 나레이션 음성(나레이터 음색)
- [ ] 입화 입모양 동기화
- [공식 사이트 개선 계획](./docs/WEBSITE_PLAN.md) —— 제품 페이지 / UTM 퍼널 / 통계
