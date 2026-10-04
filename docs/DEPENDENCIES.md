# band2sheet 추가 실행 검증에 필요한 의존성

2026-10-04, CPython 3.11 / macOS arm64의 앱 전용 `.venv`를 기준으로 공식 PyPI 메타데이터만 조사했습니다. 이번 조사에서 패키지 wheel·AI 모델을 설치하지 않았습니다.

## 필요한 설치 범위와 크기

현재 `pyproject.toml`의 선언을 만족하면서 앱과 기본 합성 테스트를 실행하는 범위는 **`.[app,dev]`**입니다. `all`, `ml`, `detail`, `lyrics`, `pdf` extras는 이 검증에 필요하지 않습니다. 용량 최소화를 위해 의존성을 강제로 생략하거나 오래된 버전을 선택하지 않았습니다.

| 직접 요구하는 패키지 | 역할 |
|---|---|
| numpy, scipy, soundfile, librosa | 샘플 배열·신호 처리·파일 입출력·pYIN/박자 분석 |
| music21, pretty_midi | MusicXML·악보/조옮김·MIDI 출력 |
| yt-dlp | 기존 설치됨; 테스트는 합성 MP4의 localhost URL만 사용 |
| fastapi, uvicorn, python-multipart | 실제 앱 서버·실행·업로드 처리 |
| pytest, httpx | 테스트 러너·FastAPI TestClient; pytest는 기존 설치됨 |

현재 미설치 항목을 해석한 결과 **추가 58개 패키지, 압축 다운로드 합계 123.22 MiB**입니다. 설치 후 디스크 사용량은 실제 설치하지 않아 측정하지 않았으며, 압축 다운로드보다 커집니다.

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

이 크기는 기존에 허용된 작은 개발 도구 설치 범위를 넘어선다고 판단해 설치를 멈췄습니다. torch·Demucs·Basic Pitch·audio-separator·CREPE·Beat This!·Whisper는 해석된 설치 계획에 없고, 현재 가상환경에도 없습니다.

원자료: [버전·파일 크기·공식 PyPI URL 목록](dependency-plan.json). [PyPI llvmlite](https://pypi.org/pypi/llvmlite/0.50.0/json), [SciPy](https://pypi.org/pypi/scipy/1.17.1/json), [music21](https://pypi.org/pypi/music21/10.5.0/json)의 파일 크기를 선택된 wheel URL과 대조했습니다. 버전/용량은 조사일 기준이며 고정 설치 lockfile이 아닙니다.

조사 명령 (설치하지 않음):

```bash
cd apps/band2sheet
.venv/bin/python -m pip install --dry-run --no-build-isolation \
  --report /tmp/band2sheet-dependency-plan.json \
  --index-url https://pypi.org/simple '.[app,dev]'
```

## 현재 차단 단계와 모델 없이 가능한 후속 검증

- 실제 `from band2sheet.app.server import create_app` 실행은 현재 `ModuleNotFoundError: fastapi`에서 중단됩니다. Web API 패키지만 설치해도 다음의 NumPy·soundfile·librosa import 및 전체 분석·악보 테스트 요구가 남습니다.
- 실제 `python -m pytest tests --collect-only --maxfail=1 -q`는 3개 테스트를 수집한 뒤 `tests/test_cli.py → band2sheet.separate`의 `ModuleNotFoundError: numpy`에서 중단됐습니다. 이를 우회하는 stub 테스트를 전체 앱 실행으로 계산하지 않았습니다.
- 기본 합성 CLI/API 테스트는 생성한 보컬·베이스·드럼 스템 폴더/ZIP을 입력하므로 분리를 생략하고 pYIN·librosa로 실행할 수 있습니다. **torch나 모델 가중치는 이 경로에 필수가 아닙니다.**
- 그러나 엔진 자동 선택이 있으므로 후속 검증도 `--system-site-packages` 없는 독립 venv에서 optional 모델 패키지가 없는지 먼저 확인해야 합니다. `BAND2SHEET_MODEL_DIR`는 저장 경로이며 다운로드 금지 스위치가 아닙니다.
- `test_separate_with_random_model`은 Demucs 없으면 skip이고, PDF 출력 테스트는 Verovio/CairoSVG/pypdf 없으면 skip입니다. 모든 optional 테스트를 포함한 완전한 전체 통과로 보고하면 안 됩니다.

설치 범위가 승인되면 기본 의존성만 설치하여 실제 API 기동과 전체 기본 합성 pytest를 진행하고, optional skip 수와 실제 음원/장치 미검증 범위를 함께 기록하면 됩니다.

```bash
# optional 모델 패키지가 없는 독립 venv임을 먼저 확인한 뒤:
PYTHONNOUSERSITE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
NUMBA_CACHE_DIR="$PWD/.cache/numba" \
.venv/bin/python -m pytest tests -q
```

이 구성에서는 Demucs·PDF 검사 2개가 skip될 것으로 예상하며, 나머지 통과 여부는 아직 확인하지 않았습니다. 실제 혼합 음원 분리와 기타·피아노 다성 채보는 각각 Demucs/Basic Pitch 등 별도 엔진이 필요한 다른 검증 범위입니다.
