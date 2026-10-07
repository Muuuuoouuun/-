# 두 앱 분리 기록

2026-10-04, 격리 복제본의 로컬 브랜치 `codex/two-apps`에서 작업했습니다. 제품 통합은 로컬에서 수행하고 별도 `codex/two-apps` 브랜치로 공유합니다. 기본 브랜치 병합·배포는 포함하지 않습니다.

## 기준과 통합

| 제품/기준 | 커밋 | 보존한 기능 |
|---|---|---|
| band2sheet 기본 브랜치 | `6977b710b15107189ec83a89eb6a152e946acafd` | 조판·셋잇단·기본음 블리딩·배음/어택 정리 |
| band2sheet 링크 브랜치 | `70ed8799ee4b9911e50cf07c9b0053309a1a30db` | 링크 받기, 음성만 다운로드, 즉시 분석, fetch-only 후 재분석 |
| 로컬 band2sheet 통합 | `091fce730d3341f2c0a65c8f7e94c333437894e4` | 두 브랜치의 공통 `c6b2537` 이후 변경을 충돌 없이 병합 |
| AirChoir Phase 2 | `e8bdf36208be39f4d829e667556b23abc8784cc0` | `air-choir/` 하위 23개 파일만 가져옴 |

AirChoir 브랜치에 함께 있던 이전 band2sheet 코드는 가져오지 않았습니다. 앱 간 제품 로직·Python/Node 의존성을 합치지 않았습니다.

## 이동 대응

| 이전 경로 | 새 경로 |
|---|---|
| `README.md`, `pyproject.toml` | `apps/band2sheet/README.md`, `apps/band2sheet/pyproject.toml` |
| `band2sheet/`, `tests/`, `docs/` | `apps/band2sheet/band2sheet/`, `apps/band2sheet/tests/`, `apps/band2sheet/docs/` |
| AirChoir 브랜치의 `air-choir/` | `apps/airchoir/` |

이동 직후 원본 78개 파일(band2sheet 55개, AirChoir 23개)의 SHA256가 모두 일치했습니다. 이후 코드 수정과 안내 경로 변경은 이 기준 위에 적용합니다. 원본 해시는 [migration-manifest.json](migration-manifest.json)에 고정되어 있습니다.

```bash
python3 scripts/verify-layout.py
```

이 검사는 Git 원본과 manifest의 대응, 모든 대상 파일의 존재와 앱별 배치를 확인하고 이동 뒤 수정한 파일을 별도로 출력합니다. 수정 내용을 원본 해시에 덮어쓰지 않습니다.

## 실행 격리

- band2sheet: 앱 내부 `.venv`, `sh dev.sh`의 기본 `.data`·`.cache`, 기본 포트 8765. 기존 CLI `band2sheet app`의 홈 데이터 경로와 옵션은 호환성을 위해 유지합니다.
- AirChoir: 앱 폴더만 정적 제공, 기본 포트 8000. 오디오·오브는 해당 페이지 메모리에 보관합니다. 카메라 모드의 모델은 브라우저 캐시에 저장됩니다.
- 두 앱은 각각 Python/Node 테스트 진입점과 문서를 가집니다. 루트의 의존성 설치나 공용 서버가 없습니다.

## 검증 경계

검증에는 실제 Python 합성 분석·악보 출력, 실제 브라우저 실행, 가짜 비동기 응답·오디오 객체를 이용한 상태 회귀가 각각 포함됩니다. 모델 런타임·가중치 다운로드, 실제 YouTube 다운로드, 실제 마이크·카메라 접근, 자격증명 사용, 외부 API·유료 호출은 하지 않습니다. 실제 채보·음성 화음 품질의 향상을 의미하지 않습니다.

최종 회귀 결과와 수정 파일 목록은 [검증 기록](VALIDATION.md)에 정리합니다.

## 전체 브랜치 통합 (2026-10-05, `claude/festive-mayer-6eu9mh`)

`codex/two-apps` 의 두 앱 레이아웃을 기준으로 나머지 브랜치를 모두 합쳤습니다.

| 브랜치 | 가져온 기능 | 통합 시 손본 점 |
|---|---|---|
| `claude/youtube-audio-to-sheet-music-zrwo2c` (`66af818`) | 곡 나누기(choose), MIDI·MusicXML 입력, 박자표 추정, 고음질 조옮김 재생·MR 받기 | 곡 찾기를 `_run` 의 try/finally 안으로 옮겨 최종 상태 저장이 lock 아래에서 끝나게 함. 새 화면을 리디자인된 HTML/CSS 로 옮김 |
| `claude/compassionate-darwin-z4jsjz` (`26d414c`) | 내 영상 후보정(화음·반주 7가지·오토튠·다시 만들기), 구간만 받기 | remix 작업도 `_submit_locked`·`final_status` 흐름을 따르게 함 (그대로면 완료 후 `error` 로 덮어써짐). 후보정 화면에 작업 문맥 검사·공용 삭제 추가 |
| `claude/funny-bardeen-p9viq0` (`e8bdf36`) | AirChoir Phase 0–2 | 내용은 이미 `apps/airchoir/` 에 있어 이력만 합침 (옛 `air-choir/` 폴더는 가져오지 않음) |

### 최적화

- **pYIN Viterbi 띠 계산** (`band2sheet/fastviterbi.py`): 음높이 상태(약 900개)마다 모든 이전 상태를 보던 계산을 한 프레임에 움직일 수 있는 띠 안만 보도록 바꿈. 띠 밖 전이도 그대로 고려해 결과는 librosa 와 비트 단위로 같음 (`tests/test_fastviterbi.py`). 보컬 23초 pYIN 8.4초 → 1.5초, 후보정 한 번 19초 → 8초, 전체 테스트 약 290초 → 170초.
- **정적 파일·JSON gzip**: 악보 라이브러리 1.4MB 를 압축해 보냄. 음원·영상(구간 요청)·PDF 는 압축하지 않음.

### 고친 점

- 선택 설치 채보 엔진(basic-pitch 등)이 없으면 작업 전체가 실패하던 것을, 그 악기만 건너뛰고 로그에 남기도록 함. 모든 악기가 빠지면 이전처럼 오류.
- 믹서를 다시 만들 때 이전 audio 의 늦은 `timeupdate` 로 나던 화면 오류(`currentTime` of undefined) 수정.
