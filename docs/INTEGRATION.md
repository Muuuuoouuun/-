# 두 앱 분리 기록

2026-10-04, 격리 복제본의 로컬 브랜치 `codex/two-apps`에서 작업했습니다. 원격 push, PR, merge, 배포는 하지 않았습니다.

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

현재 작업은 합성 파일 처리와 가짜 비동기 응답·오디오 객체를 이용한 상태·출력 검증입니다. 모델 런타임·가중치 다운로드, 실제 YouTube 다운로드, 실제 마이크·카메라 접근, 자격증명 사용, 외부 API·유료 호출은 하지 않습니다. 실제 채보·음성 화음 품질의 향상을 의미하지 않습니다.

최종 회귀 결과와 수정 파일 목록은 [검증 기록](VALIDATION.md)에 정리합니다.
