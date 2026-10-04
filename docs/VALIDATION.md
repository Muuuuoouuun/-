# 로컬 검증 기록 · 2026-10-04

분리·수정 구현은 로컬 커밋 `4663db79b1f457638ce9de48a92425a695c8f8af`로 보존했습니다. 뒤이은 문서 커밋은 검증 방식과 의존성 조사 결과만 추가합니다. 원격 push는 하지 않았습니다.

## VM과 실제 브라우저 검증의 구분

| 검증 | 실제 실행 환경 | 모의 입력·대체한 범위 | 확인하지 않은 것 |
|---|---|---|---|
| band2sheet 화면 회귀 15개 | **Node VM**에서 실제 app.js 실행 | DOM·fetch·타이머를 테스트 객체로 대체 | 실제 브라우저 레이아웃/오디오/API 서버 |
| band2sheet 브라우저 확인 | **실제 설치된 Chrome**, Playwright 1.58.2, 임시 프로필 | 실제 정적 HTML/JS/CSS + 합성 `/api/info`, 작업 목록·상태·분석 응답; 외부 HTTP 대체 | FastAPI·분석 함수·OSMD 악보 출력·실음원 |
| AirChoir 단위 45개 | Node 실행 | 신규 수명주기는 WebAudio·카메라·모델 로더 대체, 기존 DSP는 합성 배열 | 브라우저/실제 장치 품질 |
| AirChoir pointer 브라우저 확인 | **실제 설치된 Chromium** + 실제 Web Audio/AudioWorklet | 합성 데모 음성; getUserMedia는 오류를 내도록 차단; 외부 HTTP 차단 | 실제 마이크·카메라·MediaPipe |
| AirChoir Phase 0 브라우저 확인 | **실제 설치된 Chromium** | 합성 데모와 Chromium fake-device 마이크, 외부 HTTP 차단 | 하드웨어 마이크·실제 지연/음질 |

즉, 77개 단위/회귀 통과와 실제 브라우저 두 앱 확인을 별개로 수행했습니다. 실제 브라우저를 사용했다는 사실이 실제 백엔드 또는 실제 마이크를 사용했다는 뜻은 아닙니다. 추가 전체 실행을 막는 의존성과 용량은 [DEPENDENCIES.md](DEPENDENCIES.md)에 있습니다.

## band2sheet

수정 전 controlled fetch 테스트 8개가 실패했습니다. 동시 분석 요청은 두 요청 모두 등록됐고, 대기 중 작업 삭제가 허용되며 실행기 제출 실패 후 저장 상태가 `queued`로 남았습니다. 이후 재시도·작업 재방문·입력 보존 사례를 추가해 검증했습니다.

| 검사 | 결과 | 범위 |
|---|---|---|
| `python -m pytest tests/test_jobs_state.py -q` | 12 통과 | 실제 JobManager, 가짜 분석/렌더링, 임시 파일 저장, 동시 요청과 실제 ThreadPoolExecutor |
| `node --test tests/frontend*.test.cjs` | 15 통과 | 실제 app.js를 Node VM에서 로드, 지연/역순 fetch, 중복 시작, 선택 전환, 오류 후 재조회 |
| `python -m pytest tests/test_fetch.py -k 'not app' -q` | 5 통과, 앱 API 테스트 2개 제외 | ffmpeg 합성 4초 MP4, localhost HTTP, yt-dlp, 추출·잘라내기·CLI |
| `sh dev.sh --help`, `sh -n dev.sh` | 통과 | 앱 폴더 밖에서 실행 가능한 launcher·명령 인자 |
| `python -m compileall -q band2sheet`, `node --check …/app.js` | 통과 | Python/JS 구문 |
| `pip wheel --no-deps --no-build-isolation` | 통과 | 앱별 Python 패키지 빌드, 정적 화면·vendor 포함, AirChoir 미포함 |
| 기존 Chrome + Playwright 합성 API 화면 검사 | 통과 | localhost에서 ready → 분석 시작 → 다른 작업 선택 → 새 입력 화면; 중복 POST 1회만 발생, 현재 작업 유지, console/page error 없음 |

수정 파일:

- `band2sheet/app/jobs.py`: 상태 검사·저장·분석 등록을 같은 lock으로 보호. 대기/실행 중 삭제 거부, 제출 실패를 error로 저장, 최종 저장과 삭제/재시작 순서 보호.
- `band2sheet/app/static/app.js`: 작업 선택·요청 순번을 확인하고 오래된 응답 제외. 중복 분석/작업 생성 방지, 버튼 진행 표시, 상태 조회 실패 안내와 재시도, 다른 작업의 입력·오류 보존.
- `tests/test_jobs_state.py`, `tests/frontend-lifecycle.test.cjs`: 모델 없이 실행하는 회귀 검사.
- `README.md`, `dev.sh`: 새 폴더 기준 실행 및 앱 전용 데이터·캐시 안내.

환경: Python 3.11.15, Node 24.18.0, ffmpeg. 앱 전용 `.venv`에 설치한 도구는 pytest 9.1.1, yt-dlp 2026.8.19, setuptools 82.0.1, wheel 0.48.0 및 소규모 전이 의존성입니다. NumPy/SciPy/librosa/music21와 AI 런타임·모델을 새로 설치하지 않았습니다.

localhost 테스트는 기본 샌드박스의 포트 열기 제한으로 처음 실패했으나, 테스트 전용 127.0.0.1 서버 실행 예외에서 5개 모두 통과했습니다. 외부 영상은 받지 않았습니다.

화면 증거: 저장소 밖 `../qa/band2sheet-desktop-check.png` (1366×900), `../qa/band2sheet-mobile-check.png` (390×844). 페이지 제목·주요 내용·상호작용을 확인했고 오류 화면이 없었습니다. 작은 화면의 기존 헤더 줄바꿈은 유지됩니다. Browser 스킬이 제공되지 않아 기존 Playwright 1.58.2와 설치된 Chrome의 임시 프로필을 사용했습니다. 외부 요청은 테스트 응답으로 대체했으며 검사 서버는 종료했습니다.

미검증: FastAPI 앱 전체 실행과 기존 전체 pytest, 실제 음원 분리·채보·MusicXML/PDF 품질, 실제 YouTube 동작, OSMD 브라우저 렌더링. 기존 `refreshScore`/`loadSheet` 비동기 요청은 이번 stale-response 수정 범위에 포함하지 않았습니다.

## AirChoir

기존 단위 테스트 26개에 녹음/오디오/오브 9개, 카메라 수명주기 10개를 추가했습니다. `npm test` **45개 통과**, 루트 작업에서 독립 재실행해 같은 결과를 확인했습니다.

- `src/audio.js`, `core/recorder-worklet.js`: 초기화 실패 시 부분 그래프 정리·재시도, 동시 초기화 대기, 늦은 입력 권한/파일 응답 제외, 녹음 취소·실패 시 pending 요청 정리, 루프 노드·타이머·AudioContext 종료.
- `src/orbs.js`, `src/app.js`, `index.html`: 오브 삭제 뒤 늦은 녹음 응답 제외, 동기/비동기 캡처 오류 복구, 카운트인 취소·BPM 잠금, 페이지 종료/복귀 처리와 입력 전환 피드백.
- `src/hands.js`: 카메라 중지 후 늦게 온 스트림·모델 정리, 영상 재생 실패 자원 해제, 예약된 프레임 콜백 취소.
- `test/*lifecycle.test.mjs`: 실제 장치 대신 가짜 WebAudio/미디어·모델 로더를 사용한 회귀 검사.
- `package.json`, `package-lock.json`, `test/browser.mjs`, `test/pointer.check.mjs`, 기존 브라우저 검사: Playwright 개발 의존성 고정, 기본 오프라인 검사와 선택적 모델/카메라 fixture 다운로드 검사 분리.
- 앱 README/PLAN/Phase 0 README: 경로·실행·검증 경계 수정.

`npm run check` **통과**: 설치된 Playwright/Chromium을 재사용하고 외부 HTTP를 차단했습니다. 마우스 모드의 실제 AudioWorklet 합성 데모에서 **카운트인 취소 → 녹음 → 루프 → 삭제**, 페이지 종료 시 context 닫힘 및 복귀 후 재시작을 확인했습니다. 400px 화면의 가로 넘침은 0입니다. Phase 0에서는 합성 음성과 가짜 마이크로 엔진·화음 표시를 확인했습니다. 관련 페이지 오류가 없었습니다.

```bash
cd apps/airchoir
npm test
# 이미 설치된 Playwright/브라우저를 사용하는 경우:
PLAYWRIGHT_MODULE=/절대/경로/playwright/index.mjs npm run check
```

스크린샷은 저장소 밖 `../qa/pointer-desktop.png`, `pointer-mobile.png`, `phase0-desktop.png`, `phase0-mobile.png`입니다. 실제 마이크·카메라 권한, MediaPipe 모델 다운로드, 실제 목소리 품질·하드웨어 지연은 검증하지 않았습니다. 테스트에서 나온 엔진 처리 시간·RMS·표시 지연을 실제 품질 개선이나 종단 지연 수치로 해석하지 않습니다.

## 이동 및 기능 보존

이동 직후 78개 파일의 해시 일치, 최종 대상 파일 존재 여부와 원본 Git 대응은 `python3 scripts/verify-layout.py`로 확인합니다. 원본 branch의 제품별 독점 변경과 조판/링크 CLI 옵션도 독립 검토했습니다. 원본 해시와 이동 후 수정 목록은 구분됩니다.

## 추천 다음 순서

1. 두 앱의 상태·취소·실패 회귀 검사를 유지하며, band2sheet 전체 의존성 설치 범위를 정해 기존 합성 파이프라인 테스트 실행.
2. 동의받은 짧은 테스트 음원으로 악보 정확도 및 AirChoir 실시간 지연·음질을 각각 평가. 모델/장치 권한은 필요한 단계에서 별도 결정.
3. band2sheet의 기존 악보 XML 요청 경쟁 및 편집 저장 흐름 점검. AirChoir 실제 장치 중단·브라우저 복귀 흐름 점검.
4. AirChoir 합주(Phase 3)는 별도 설계·범위 합의 후 진행.
