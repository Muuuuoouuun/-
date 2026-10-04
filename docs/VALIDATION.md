# 검증 기록 · 2026-10-04

**후속 AirChoir 휠 작업:** 사용자 설정 휠·코드 신스·한손/두손 입력을 추가한 현재 AirChoir 단위 검사는 **115개 통과**입니다. 기존 브라우저 검사와 새 모드 검사, 합성 카메라 데스크톱·모바일 각 12개를 확인했습니다. 아래 208개 기록은 이전 두 앱 UI 단계의 실행 결과이며, 이번에는 band2sheet를 변경하거나 전체 재검사하지 않았습니다. 현재 구현·검증 범위와 미검증 사항은 [AIRCHOIR_WHEELS.md](AIRCHOIR_WHEELS.md)에 있습니다.

두 앱은 독립 실행 환경에서 확인했습니다. **band2sheet Python 77개 통과·2개 skip, 화면 상태·편집 80개 통과, AirChoir 51개 통과**입니다. UI 개선 후 다시 실행한 자동 검사는 총 **208개 통과·2개 skip**입니다. 아래 표는 실제 실행과 모의 입력의 경계를 구분합니다. 화면 구성의 근거와 전후 측정은 [UI_REFINEMENT.md](UI_REFINEMENT.md)에 있습니다.

## 실행 환경과 모의 범위

| 검증 | 실제 실행 환경 | 입력·대체 범위 | 확인하지 않은 것 |
|---|---|---|---|
| band2sheet 전체 Python | Python 3.11.15, 실제 FastAPI TestClient·JobManager·pYIN/librosa·music21·ffmpeg | 생성한 스템 WAV/ZIP/MP4, 일부 수명주기 테스트만 분석 함수를 대체 | 혼합 음원 분리 모델·실제 YouTube·실음원 정확도 |
| band2sheet 화면 회귀 80개 | Node 24.18.0 VM에서 실제 app.js·views.js 실행 | DOM·fetch·타이머·OSMD를 테스트 객체로 대체, 지연·역순 응답 | 실제 브라우저 레이아웃·백엔드 |
| band2sheet 지연 응답 화면 확인 | 실제 설치된 Chrome, Playwright 1.58.2, 임시 프로필 | 실제 정적 화면 + 합성 API 응답 | FastAPI·분석 함수·악보 출력 |
| band2sheet 전체 브라우저 흐름 | 실제 설치된 Chrome + localhost uvicorn/FastAPI, 실제 분석·OSMD·다운로드 | 합성 스템 ZIP, 외부 통신 차단 | 실음원 정확도·하드웨어 재생 |
| AirChoir 단위 51개 | Node 실행 | DSP는 합성 배열, 수명주기는 WebAudio·카메라·모델 로더 대체 | 실제 장치 품질 |
| AirChoir pointer 화면 확인 | 실제 설치된 Chromium + 실제 Web Audio/AudioWorklet | 합성 데모 음성; getUserMedia 차단; 외부 HTTP 차단 | 실제 마이크·카메라·MediaPipe |
| AirChoir Phase 0 화면 확인 | 실제 설치된 Chromium | 합성 데모와 Chromium fake-device 마이크, 외부 HTTP 차단 | 하드웨어 입력·실제 지연/음질 |
| AirChoir 조작·접근성 확인 | 실제 설치된 Chrome + Web Audio/AudioWorklet, 1440×1000·1280×800·390×844 | 합성 데모, 지연 getUserMedia·카메라 시작 실패는 모의 객체, 외부 HTTP 차단 | 실제 마이크·카메라 권한·장치 |

208개 자동 검사 통과와 실제 브라우저 확인은 별도 결과입니다. 실제 브라우저를 사용했다는 사실이 실제 마이크 또는 실제 음악 녹음을 사용했다는 뜻은 아닙니다.

## band2sheet

이전 통합 단계에서 승인받아 설치한 `.[app,dev]`와 앱 전용 `.venv`를 재사용했습니다. 해당 환경의 `pip check`와 실제 라우트 23개 생성은 이전 단계에서 확인했습니다. torch·Demucs·Basic Pitch·audio-separator·CREPE·Beat This!·Whisper가 없는 상태이며 이번 UI 작업에 새 모델이나 의존성을 설치하지 않았습니다. 의존성 크기와 버전은 [DEPENDENCIES.md](DEPENDENCIES.md)에 있습니다.

전체 Python 검사는 **77 passed, 2 skipped, 4 warnings**, 51.22초였습니다. 실제 합성 스템 업로드/분석, 코드·가사·음표 편집, 조옮김, MusicXML·MIDI·ZIP·미리듣기 경로를 포함합니다. 링크 처리는 합성 MP4를 localhost HTTP 서버에서 읽었습니다. 테스트 Python 프로세스는 loopback 이외의 소켓·DNS 연결을 거부하는 외부 검사 장치 아래 실행했습니다.

선택 의존성으로 건너뛴 검사:

- `test_separate_with_random_model`: Demucs 미설치.
- `test_pdf_export`: Verovio/CairoSVG/pypdf 미설치.

경고 4개는 Starlette의 httpx TestClient 사용 안내 1개와 audioread의 Python 3.13에서 제거되는 표준 모듈 안내 3개입니다. Python 3.11 실행 실패는 없었습니다.

```bash
cd apps/band2sheet
PYTHONNOUSERSITE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
NUMBA_CACHE_DIR="$PWD/.cache/numba" MPLCONFIGDIR="$PWD/.cache/matplotlib" \
.venv/bin/python -m pytest tests -q
node --test tests/frontend*.test.cjs
```

상태 수정은 수정 전 동시 분석의 중복 등록, 대기 작업 삭제, 제출 실패 후 영구 대기, 이전 작업 응답의 화면 덮어쓰기를 재현한 뒤 적용했습니다. 회귀에는 실제 스레드 실행기, 지연/역순 fetch, 작업 재방문, 오류 후 재조회, 새 입력 보존을 포함합니다.

화면 회귀 80개는 지연된 XML·OSMD 렌더 응답의 작업/악기 전환 경합, 조옮김 응답 대기 중 추가 편집, 저장 중 새 편집·undo, 같은 악보를 다시 불러올 때 미저장 음표 보존을 포함합니다. 코드·가사는 저장 대상을 캡처하고 이전 작업의 응답으로 새 화면을 덮어쓰지 않습니다. 키보드 팝업·Escape 복귀와 팝업 밖 가사/선택 상자를 클릭할 때 포커스 유지도 검사합니다.

실제 uvicorn/FastAPI와 Chrome을 연결한 최종 UI 검사에서는 **합성 ZIP 업로드 → 분석 완료 → A 조옮김 → OSMD 총보·베이스 TAB → 음표·가사 저장 → 새 ZIP 다운로드**를 통과했습니다. 빠른 악기 전환, 새 작업 이동 취소 후 편집 보존, 코드 저장 오류의 입력 유지, 코드 저장 후 미저장 음표 보존, 오프라인 재조회 후 복구, 잘못된 ZIP의 실패 안내까지 확인했습니다. 실제 조옮김 응답을 지연시킨 동안 포인터로 새 음표를 수정하는 추가 검사에서도 원래 조성·수정·undo가 보존됐습니다.

최종 브라우저 체크리스트 16개가 통과했습니다. 페이지 오류와 외부 요청은 0건입니다. 콘솔 오류 3건은 의도한 잘못된 코드의 HTTP 400 한 건과 오프라인 테스트 두 건이며 예상 밖 오류는 없었습니다. 데스크톱 1440×1000·1280×800과 모바일 390×844에서 가로 넘침, 모바일 주요 버튼의 44px 높이, 고정 플레이어 위 키보드 포커스 노출을 확인했습니다. 인쇄 모드의 코드·가사·마디 표시는 흰 배경과 어두운 글자로 유지됩니다.

최종 다운로드 ZIP은 11개 파일이며 MusicXML 5개 파싱과 MIDI 4개 포함을 확인했습니다. 총보의 원래 제목과 A 장조(`fifths=3`), 코드 차트의 저장된 가사가 유지됩니다. MusicXML에 가사를 주입하는 새 기능은 추가하지 않았습니다.

Python 구문, JavaScript 구문, launcher 명령과 앱별 wheel 빌드도 확인했습니다. UI 변경 후 네트워크·추가 의존성 설치 없이 wheel을 다시 만들었으며 정적 자산 7개의 현재 소스와 바이트 일치 및 AirChoir 미포함을 확인했습니다.

## AirChoir

`npm test`는 기존 DSP·제스처·오브·오디오·카메라 수명주기와 녹음 시작/완료/취소·배치 상태 전이를 포함해 **51개가 통과**했습니다.

`npm run check`의 pointer·Phase 0·controls 검사 모두 통과했습니다. 실제 AudioWorklet 합성 데모로 **카운트인 취소 → 녹음 → 루프 세 개 → 선택·음소거·삭제·배치**, BPM 잠금과 세션 종료 후 AudioContext 닫힘을 확인했습니다. Space/Escape 및 폼 입력 중 단축키 억제, 시작 취소 후 즉시 재시작, 파일 오류 후 같은 파일 재선택, 방향키 이동, 활성 녹음 버튼·선택 루프로 포커스 복귀도 확인했습니다. 세 화면 크기에서 관련 페이지 오류와 외부 요청은 0건입니다. 녹음 버튼의 일반·카운트인·녹음 상태와 hover 대비는 4.5:1 이상입니다.

```bash
cd apps/airchoir
npm test
npm run check
# 설치된 Chrome을 사용하는 환경:
BROWSER_CHANNEL=chrome npm run check
# 기존 Playwright 설치를 재사용할 때만 PLAYWRIGHT_MODULE을 지정
```

브라우저·모델은 신규 설치하지 않았습니다. 별도 `check:camera`는 MediaPipe·모델·사진을 받는 선택 검사이며 이번 실행에서 제외했습니다. 화면의 지연 추정치·합성 RMS·DSP 처리 시간을 실제 지연이나 음질 개선 수치로 해석하지 않습니다.

## 파일·환경 보존과 공개 범위

원본 78개 파일의 이동 직후 해시 일치를 확인했고, `python3 scripts/verify-layout.py`로 Git 출처와 최종 파일 대응을 검사합니다. 기본/링크 브랜치 고유 기능과 CLI 조판 옵션은 함께 보존합니다.

공개 범위는 제품 소스, 합성 입력을 생성하는 테스트 코드, 일반화한 문서입니다. 로컬 경로·인증정보·가상환경·캐시·테스트 음원·로그·QA 스크린샷은 추적 파일에 포함하지 않습니다. 기존 문서 이미지 11개는 원격 저장소에 이미 있던 동일한 blob입니다. 브라우저 증거와 상세 실행 로그는 로컬 산출물로만 보관합니다.

## 남은 범위

- 실제 녹음의 채보 정확도, 혼합 음원 분리, 실제 YouTube 동작, PDF 출력.
- 실제 마이크·웹캠, 하드웨어 지연·박자 보정, 모바일 Safari.
- 브라우저/장치별 장시간 세션과 실제 음악을 사용한 추가 사용성 평가.
- AirChoir 합주(Phase 3)는 별도 기능 설계 범위.

다음 단계는 사용 가능한 짧은 테스트 음원과 장치로 각각 품질 기준을 정해 평가하는 것입니다. 필요한 모델·장치 권한은 그 단계의 범위에 맞춰 선택합니다.
