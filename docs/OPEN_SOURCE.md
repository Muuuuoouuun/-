# 음악 분리·채보 오픈소스 조사 (2026년 10월)

band2sheet 에 붙일 수 있는 오픈소스를 단계별로 정리했습니다.
**✅ 적용** = 지금 band2sheet 에 연결됨, **🔜 후보** = 다음에 붙일 만함, **➖ 보류** = 이유 참고.

> 라이선스: 코드 라이선스와 **모델 가중치 라이선스가 다를 수 있습니다.** 상업적으로 쓰기 전에는 각 모델 카드를 꼭 확인하세요.

## 1. 음원 분리 (악기별로 나누기)

| 프로젝트 | 하는 일 | 상태 | 메모 |
|---|---|---|---|
| [Demucs v4](https://github.com/facebookresearch/demucs) (`htdemucs_6s`) | 보컬/드럼/베이스/기타/피아노/기타악기 6스템 | ✅ 기본 | MIT. 기타·피아노까지 나누는 몇 안 되는 공개 모델 |
| [python-audio-separator](https://pypi.org/project/audio-separator/) (UVR 모델 모음) | 아래 RoFormer·DrumSep·Karaoke 모델 실행기 | ✅ | MIT. 모델은 첫 실행 때 자동 다운로드 |
| BS-RoFormer (`model_bs_roformer_ep_317_sdr_12.9755`) | 보컬/반주 분리 (보컬 SDR ≈ 12.9) | ✅ `--quality high` | SDX'23 1위 계열 구조 ([논문](https://arxiv.org/pdf/2310.01809)) |
| Mel-RoFormer Karaoke (aufr33·viperx) | **메인 보컬 / 코러스(화음) 분리** | ✅ 기본 | 예배 영상의 싱어·성가대 분리에 유용 |
| MDX23C DrumSep (aufr33·jarredou) | **드럼 → 킥/스네어/탐/하이햇/라이드/크래시** | ✅ 기본 | 드럼 채보 정확도를 크게 올림 ([관련 연구](https://arxiv.org/html/2509.24853v1)) |
| [Music Source Separation Toolkit 2026](https://huggingface.co/collections/StemSplitio/music-source-separation-toolkit-2026) | 최신 공개 분리 모델 모음/벤치마크 | 🔜 | 더 좋은 기타/건반 분리 모델이 나오면 교체 |
| Spleeter, Open-Unmix | 2~5 스템 분리 | ➖ | Demucs/RoFormer 보다 품질 낮음 |

## 2. 채보 (소리 → 음표)

| 프로젝트 | 대상 | 상태 | 메모 |
|---|---|---|---|
| [Basic Pitch](https://github.com/spotify/basic-pitch) (Spotify) | 다성 악기 (기타·건반·코러스) | ✅ | Apache-2.0, 가볍고 모델이 패키지에 포함 |
| [CREPE / torchcrepe](https://github.com/maxrmorrison/torchcrepe) | 단선율 음높이 (보컬·베이스) | ✅ 기본 | MIT, 모델이 패키지에 포함 → 설치만 하면 동작 |
| pYIN (librosa) | 단선율 음높이 | ✅ 대체 | 추가 모델 없이 동작 |
| [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) (ByteDance) | 피아노 음 + **서스테인 페달** | ✅ | MAESTRO onset F1 96.7%, 페달 F1 91.9% ([논문](https://arxiv.org/pdf/2010.01815v2)) |
| [RMVPE](https://arxiv.org/abs/2306.15412v2) | 반주 섞인 음원에서 보컬 음높이 | 🔜 | 분리 품질이 나쁜 라이브 녹음에서 유리 |
| [YourMT3+](https://papers.pytorch.kr/papers/2407.04822) | 다악기 동시 채보 (Slakh F1 ≈ 0.85) | 🔜 | Basic Pitch(0.43), MT3(0.57)보다 훨씬 좋음. 무겁고 설치가 복잡해 별도 엔진으로 검토 ([2025 AMT 챌린지](https://arxiv.org/pdf/2603.27528)) |
| MuScriptor | 다악기 채보 (대형) | ➖ | 가중치 CC-BY-NC (비상업) |
| [TART](https://arxiv.org/html/2510.02597v1) | 기타 TAB + 주법(슬라이드, 해머링 등) | 🔜 | 기타 상세 표기 개선용 |

## 3. 드럼 채보

| 프로젝트 | 상태 | 메모 |
|---|---|---|
| DrumSep 조각 + 조각별 타격 검출 (band2sheet 자체) | ✅ | 킥·스네어·하이햇(열림/닫힘)·탐 3종·라이드·크래시 |
| 대역 분석 분류기 (band2sheet 자체) | ✅ 대체 | 조각 분리가 없을 때: 킥·스네어·하이햇·크래시 |
| [ADTOF](https://github.com/MZehren/ADTOF) (ADTOF-pytorch) | 🔜 | 5종(킥·스네어·하이햇·탐·심벌) 딥러닝 채보, 현재 최고 수준 |
| [ADTLib](https://libraries.io/pypi/ADTLib) | ➖ | 오래됨 (킥·스네어·하이햇만) |

## 4. 박자 / 곡 구조

| 프로젝트 | 상태 | 메모 |
|---|---|---|
| [Beat This!](https://gittrend.io/repo/CPJKU/beat_this) (CPJKU, ISMIR 2024) | ✅ | 비트 + **마디 첫 박** → 박자표(3/4, 4/4) 자동 추정 |
| librosa beat_track | ✅ 대체 | 템포 직접 지정(`--bpm`) 시에도 사용 |
| [All-In-One (allin1)](https://pypi.org/project/allin1/0.4.0/) | 🔜 | 전주/절/후렴/브리지 구간 인식 → 악보에 리허설 마크 |

## 5. 코드 인식

| 프로젝트 | 상태 | 메모 |
|---|---|---|
| band2sheet 템플릿 + 비터비 | ✅ | 분리·채보한 음표로 계산 (슬래시 코드 포함) |
| [BTC](https://github.com/qf6101/BTC-ISMIR19) (Bi-directional Transformer) | 🔜 | 170개 코드 어휘, 오디오 직접 인식 ([모델](https://huggingface.co/puar-playground/btc-chord)) |
| [Chordino](https://code.soundsoftware.ac.uk/projects/nnls-chroma) / [chord-extractor](https://pypi.org/project/chord-extractor) | ➖ | Vamp 플러그인 설치 필요 |
| [autochord](https://pypi.org/project/autochord) | ➖ | TensorFlow + Vamp 의존 |

## 6. 가사 (음성 인식)

| 프로젝트 | 상태 | 메모 |
|---|---|---|
| [WhisperX](https://www.isca-archive.org/interspeech_2023/bain23_interspeech.html) | ✅ 우선 | 강제 정렬로 단어 시간이 정확 → 음표에 음절 배치가 잘 맞음 |
| faster-whisper | ✅ | 가볍고 빠름 |

## 앞으로의 우선순위 제안

1. **ADTOF** 드럼 엔진 (DrumSep 없이도 5종 채보)
2. **allin1** 곡 구조 → 악보에 [Intro] [Verse] [Chorus] 표시, 코드표 섹션 나누기
3. **YourMT3+** 를 '정밀 채보' 옵션으로 (GPU 권장)
4. **BTC** 코드 인식과 현재 방식 비교·앙상블
5. 기타 주법(TART) / 카포·코드 다이어그램
