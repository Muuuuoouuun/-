# 음악 앱 작업실

같은 저장소에서 두 제품을 독립적으로 개발합니다. 각 앱의 실행 위치, 의존성, 테스트와 데이터는 분리되어 있습니다.

| 앱 | 하는 일 | 코드와 설명 | 로컬 주소 |
|---|---|---|---|
| **band2sheet · 악보 스튜디오** | 영상·음원·링크를 악기별 악보로 변환하고 코드·가사·음표 편집 | [apps/band2sheet](apps/band2sheet/README.md) | `http://127.0.0.1:8765` |
| **AirChoir · 허밍 합창단** | 목소리 화음, 손동작 지휘, 녹음한 오브 반복 재생 (Phase 2) | [apps/airchoir](apps/airchoir/README.md) · [계획](apps/airchoir/PLAN.md) | `http://localhost:8000` |

## band2sheet 시작

Python 3.10/3.11과 ffmpeg가 필요합니다. 저장소 루트에서:

```bash
cd apps/band2sheet
python3.11 -m venv .venv
.venv/bin/python -m pip install -e ".[app,dev]"
sh dev.sh
```

`dev.sh`는 앱 폴더의 `.venv`를 사용하고 새 작업은 `.data/`, 모델·라이브러리 캐시는 `.cache/`에 둡니다. 기존 `~/band2sheet-data`를 열려면 `BAND2SHEET_DATA="$HOME/band2sheet-data" sh dev.sh`처럼 명시합니다. 기존 데이터를 자동 이동하지 않습니다.

위 설치는 기본 분석·앱 의존성입니다. 혼합 음원을 분리하려면 별도의 ML 엔진이 필요합니다. `ml`·`detail`·`lyrics` 옵션과 첫 실행 모델 다운로드는 [앱 설치 안내](apps/band2sheet/README.md#설치)를 확인한 뒤 선택하세요. 멀티트랙 입력은 분리 단계를 건너뛸 수 있습니다.

## AirChoir 시작

저장소 루트에서:

```bash
cd apps/airchoir
npm start
```

Node와 Python 3가 필요하며 앱 실행 자체에 npm 설치는 필요하지 않습니다. **카메라 없이 마우스로 해 보기**는 합성 데모로 시작합니다. 카메라 모드는 MediaPipe를 외부에서 받아오며, 마이크·카메라 사용에는 브라우저 권한이 필요합니다. 녹음 오브는 브라우저 메모리에 있고 페이지를 닫으면 사라집니다. band2sheet 데이터와 공유되지 않습니다.

## 개발과 검증

각 명령은 해당 앱 폴더에서 실행합니다.

| 범위 | 명령 | 필요 조건 |
|---|---|---|
| band2sheet 작업 상태 | `.venv/bin/python -m pytest tests/test_jobs_state.py` | pytest, 분석 부분은 가짜 함수로 대체 |
| band2sheet 화면 상태 | `node --test tests/frontend*.test.cjs` | Node, 외부 통신 없음 |
| band2sheet 로컬 파일 처리 | `.venv/bin/python -m pytest tests/test_fetch.py -k 'not app'` | pytest, yt-dlp, ffmpeg; 합성 MP4와 localhost만 사용 |
| band2sheet 전체 | `.venv/bin/python -m pytest` | 전체 기본 의존성, 선택 엔진 설치 상태에 따라 범위 달라짐 |
| AirChoir 단위 검사 | `npm test` | Node, 실제 장치 없이 실행 |

AirChoir 브라우저 검사에는 추가 도구가 필요합니다. 자동 모델 다운로드 여부와 선택 실행법은 [앱 테스트 안내](apps/airchoir/README.md#테스트)를 먼저 확인하세요. 자동 테스트의 상태·출력 검증과 실제 음원의 채보·화음 품질 평가는 구분합니다.

## 폴더와 이전 작업

```text
apps/
  band2sheet/  # Python 패키지 band2sheet/, tests/, docs/, pyproject.toml
  airchoir/    # 브라우저 ES 모듈 src/, core/, phase0/, test/, package.json
docs/         # 통합 출처와 검증 기록
scripts/      # 두 앱의 이동 대응 검사
```

band2sheet 기본 브랜치의 조판·셋잇단·블리딩 개선과 링크 브랜치의 다운로드·즉시 분석을 로컬에서 통합했습니다. AirChoir 브랜치에서는 `air-choir/`만 가져왔습니다. 원본 브랜치와 Git 이력은 보존합니다. [통합 기록](docs/INTEGRATION.md)과 [이동 전 파일 해시](docs/migration-manifest.json)를 참조하세요.
