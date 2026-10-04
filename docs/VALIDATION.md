# 검증 기록 · 2026-10-04

두 앱은 독립 실행 환경에서 확인했습니다. **band2sheet Python 77개 통과·2개 skip, 화면 상태 15개 통과, AirChoir 45개 통과**입니다. 아래 표는 실제 실행과 모의 입력의 경계를 구분합니다.

## 실행 환경과 모의 범위

| 검증 | 실제 실행 환경 | 입력·대체 범위 | 확인하지 않은 것 |
|---|---|---|---|
| band2sheet 전체 Python | Python 3.11.15, 실제 FastAPI TestClient·JobManager·pYIN/librosa·music21·ffmpeg | 생성한 스템 WAV/ZIP/MP4, 일부 수명주기 테스트만 분석 함수를 대체 | 혼합 음원 분리 모델·실제 YouTube·실음원 정확도 |
| band2sheet 화면 회귀 15개 | Node 24.18.0 VM에서 실제 app.js 실행 | DOM·fetch·타이머를 테스트 객체로 대체 | 실제 브라우저 레이아웃·백엔드 |
| band2sheet 지연 응답 화면 확인 | 실제 설치된 Chrome, Playwright 1.58.2, 임시 프로필 | 실제 정적 화면 + 합성 API 응답 | FastAPI·분석 함수·악보 출력 |
| band2sheet 전체 브라우저 흐름 | 실제 설치된 Chrome + localhost uvicorn/FastAPI, 실제 분석·OSMD·다운로드 | 합성 스템 ZIP, 외부 통신 차단 | 실음원 정확도·하드웨어 재생 |
| AirChoir 단위 45개 | Node 실행 | DSP는 합성 배열, 신규 수명주기는 WebAudio·카메라·모델 로더 대체 | 실제 장치 품질 |
| AirChoir pointer 화면 확인 | 실제 설치된 Chromium + 실제 Web Audio/AudioWorklet | 합성 데모 음성; getUserMedia 차단; 외부 HTTP 차단 | 실제 마이크·카메라·MediaPipe |
| AirChoir Phase 0 화면 확인 | 실제 설치된 Chromium | 합성 데모와 Chromium fake-device 마이크, 외부 HTTP 차단 | 하드웨어 입력·실제 지연/음질 |

137개 자동 검사 통과와 실제 브라우저 확인은 별도 결과입니다. 실제 브라우저를 사용했다는 사실이 실제 마이크 또는 실제 음악 녹음을 사용했다는 뜻은 아닙니다.

## band2sheet

공식 PyPI의 `.[app,dev]`를 앱 전용 `.venv`에 설치했습니다. `pip check`는 통과했고 `create_app`은 실제 라우트 23개를 생성했습니다. torch·Demucs·Basic Pitch·audio-separator·CREPE·Beat This!·Whisper가 없는 상태를 확인했습니다. 의존성 크기와 버전은 [DEPENDENCIES.md](DEPENDENCIES.md)에 있습니다.

전체 Python 검사는 **77 passed, 2 skipped, 4 warnings**, 78.88초였습니다. 실제 합성 스템 업로드/분석, 코드·가사·음표 편집, 조옮김, MusicXML·MIDI·ZIP·미리듣기 경로를 포함합니다. 링크 처리는 합성 MP4를 localhost HTTP 서버에서 읽었습니다. 테스트 Python 프로세스는 loopback 이외의 소켓·DNS 연결을 거부하는 외부 검사 장치 아래 실행했습니다.

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

기존 Chrome의 합성 API 검사에서는 ready → 분석 시작 → 다른 작업 선택 → 새 입력 화면을 확인했습니다. 중복 POST는 1회로 제한됐고 현재 작업이 유지됐으며 console/page error가 없었습니다. 데스크톱 1366×900과 모바일 390×844에서 화면을 확인했습니다. 작은 화면의 기존 헤더 줄바꿈은 유지됩니다.

실제 uvicorn/FastAPI와 Chrome을 연결한 별도 검사에서는 **합성 ZIP 업로드 → 분석 완료(G) → A(+2) 조옮김 → OSMD 총보 → 베이스 TAB → ZIP 다운로드**를 통과했습니다. 총보 SVG에 260개 path가 있었고, 다운로드의 11개 파일 중 MusicXML 5개를 파싱하고 MIDI 4개를 확인했습니다. A 조표는 `fifths=3`, 베이스 TAB은 4줄이었습니다. 실제 API 응답은 정상(200, 음원 206)이었으며 페이지·콘솔 오류와 외부 요청은 0건이었습니다.

이 흐름의 데스크톱 1440×1000과 모바일 390×844 화면도 확인했습니다. 모바일 새 context에서 헤더 1개, 가로 넘침 없음, 하단 플레이어 위치 정상을 확인했습니다. 검사 종료 후 임시 서버와 브라우저를 종료했습니다.

Python 구문, JavaScript 구문, launcher 명령, 앱별 wheel 빌드도 통과했습니다. wheel의 jobs.py/app.js/vendor가 현재 소스와 일치하고 AirChoir가 포함되지 않음을 확인했습니다.

## AirChoir

`npm test`는 기존 DSP/제스처/오브 26개와 신규 오디오·녹음·카메라 수명주기 19개, 합계 **45개가 통과**했습니다.

`npm run check`도 통과했습니다. 실제 AudioWorklet 합성 데모로 **카운트인 취소 → 녹음 → 루프 → 삭제**, BPM 잠금, 페이지 종료 시 AudioContext 닫힘 및 복귀 후 재시작을 확인했습니다. 400px 화면의 가로 넘침은 0이며 관련 페이지 오류가 없었습니다. Phase 0의 합성 입력·가짜 마이크에서도 음·화음 표시와 콘솔 상태를 확인했습니다. 종료 후 검사 서버 리스너와 관련 프로세스가 남지 않았습니다.

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
- 기존 악보 XML 요청의 동시 전환 경합과 추가 편집 저장 흐름.
- AirChoir 합주(Phase 3)는 별도 기능 설계 범위.

다음 단계는 사용 가능한 짧은 테스트 음원과 장치로 각각 품질 기준을 정해 평가하는 것입니다. 필요한 모델·장치 권한은 그 단계의 범위에 맞춰 선택합니다.
