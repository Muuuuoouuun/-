# band2sheet 추가 실행 검증에 필요한 의존성

2026-10-04, CPython 3.11 / macOS arm64의 앱 전용 `.venv`를 기준으로 공식 PyPI 메타데이터를 조사한 뒤 아래 기본 의존성을 설치했습니다. `pip check`는 통과했고 전체 Python 검사는 77개 통과, 2개 skip입니다. AI 런타임·모델은 설치하지 않았습니다.

## 필요한 설치 범위와 크기

현재 `pyproject.toml`의 선언을 만족하면서 앱과 기본 합성 테스트를 실행하는 범위는 **`.[app,dev]`**입니다. `all`, `ml`, `detail`, `lyrics`, `pdf` extras는 이 검증에 필요하지 않습니다. 용량 최소화를 위해 의존성을 강제로 생략하거나 오래된 버전을 선택하지 않았습니다.

| 직접 요구하는 패키지 | 역할 |
|---|---|
| numpy, scipy, soundfile, librosa | 샘플 배열·신호 처리·파일 입출력·pYIN/박자 분석 |
| music21, pretty_midi | MusicXML·악보/조옮김·MIDI 출력 |
| yt-dlp | 기존 설치됨; 테스트는 합성 MP4의 localhost URL만 사용 |
| fastapi, uvicorn, python-multipart | 실제 앱 서버·실행·업로드 처리 |
| pytest, httpx | 테스트 러너·FastAPI TestClient; pytest는 기존 설치됨 |

최소 테스트 도구만 있던 환경에 추가된 패키지는 **58개, 압축 다운로드 합계 123.22 MiB**입니다. 이 값은 선택된 배포 파일 크기의 합이며, 설치 후 디스크 사용량을 뜻하지 않습니다.

| 주요 추가 패키지 | 선택 버전 | 파일 크기 (MiB) |
|---|---|---:|
| llvmlite | 0.50.0 | 38.656 |
| scipy | 1.17.1 | 19.392 |
| music21 | 10.5.0 | 19.188 |
| matplotlib | 3.11.2 | 8.860 |
| scikit-learn | 1.9.1 | 7.907 |
| pretty_midi | 0.2.11.post0 | 5.338 |
| numpy | 2.4.6 | 5.216 |
| pillow | 12.3.0 | 4.564 |
| fonttools | 4.66.1 | 2.946 |
| numba | 0.68.0 | 2.632 |
| pydantic_core | 2.46.5 | 1.833 |
| soundfile | 0.14.0 | 1.053 |

Web API 관련 18개 패키지만 합치면 3.36 MiB이나, 현재 서버는 `server.py → pipeline.py → rhythm.py`를 바로 import하므로 과학 계산 의존성도 필요합니다. 해당 신호·악보 스택의 전이 의존성은 43개/120.10 MiB이며 Web API 그룹과 일부 중복됩니다. llvmlite는 numba의 LLVM 실행 라이브러리이고 **AI 모델이나 torch가 아닙니다**. scikit-learn 또한 librosa의 선언된 의존성으로 포함되며 이 조사에서 모델 가중치를 받는다는 의미가 아닙니다.

torch·Demucs·Basic Pitch·audio-separator·CREPE·Beat This!·Whisper는 이 기본 설치 계획에 없고, 검증 환경에도 없습니다. 학습된 모델이 없는 상태를 확인한 뒤 합성 테스트를 실행했습니다.

원자료: [버전·파일 크기·공식 PyPI URL 목록](dependency-plan.json). [PyPI llvmlite](https://pypi.org/pypi/llvmlite/0.50.0/json), [SciPy](https://pypi.org/pypi/scipy/1.17.1/json), [music21](https://pypi.org/pypi/music21/10.5.0/json)의 파일 크기를 선택된 wheel URL과 대조했습니다. 버전/용량은 조사일 기준이며 고정 설치 lockfile이 아닙니다.

조사 명령 (설치하지 않음):

```bash
cd apps/band2sheet
mkdir -p .cache
.venv/bin/python -m pip install --dry-run --no-build-isolation \
  --report .cache/dependency-plan.json \
  --index-url https://pypi.org/simple '.[app,dev]'
```

## 모델 없는 실행 범위

- 실제 `create_app` 생성과 기본 서버 의존성 import가 성공했습니다. 기존 fastapi·numpy 미설치 차단은 해소됐습니다.
- 전체 `pytest tests -q`는 77개 통과, 2개 skip이며 분석·렌더링을 실제로 실행하는 합성 CLI/API 검사도 포함합니다.
- 기본 합성 CLI/API 테스트는 생성한 보컬·베이스·드럼 스템 폴더/ZIP을 입력하므로 분리를 생략하고 pYIN·librosa로 실행할 수 있습니다. **torch나 모델 가중치는 이 경로에 필수가 아닙니다.**
- 그러나 엔진 자동 선택이 있으므로 후속 검증도 `--system-site-packages` 없는 독립 venv에서 optional 모델 패키지가 없는지 먼저 확인해야 합니다. `BAND2SHEET_MODEL_DIR`는 저장 경로이며 다운로드 금지 스위치가 아닙니다.
- `test_separate_with_random_model`은 Demucs 없으면 skip이고, PDF 출력 테스트는 Verovio/CairoSVG/pypdf 없으면 skip입니다. 모든 optional 테스트를 포함한 완전한 전체 통과로 보고하면 안 됩니다.

재현 시에는 기본 의존성만 설치하고 아래 명령으로 전체 기본 합성 검사를 실행합니다. localhost HTTP fixture를 열 수 있는 환경이 필요하며, 검증 기록의 외부 통신 차단 조건을 유지합니다.

```bash
# optional 모델 패키지가 없는 독립 venv임을 먼저 확인한 뒤:
PYTHONNOUSERSITE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
NUMBA_CACHE_DIR="$PWD/.cache/numba" \
.venv/bin/python -m pytest tests -q
```

이 구성에서 Demucs·PDF 검사 2개가 실제로 skip됐고, 나머지 77개는 통과했습니다. 실제 혼합 음원 분리와 기타·피아노 다성 채보는 각각 Demucs/Basic Pitch 등 별도 엔진이 필요한 다른 검증 범위입니다.
