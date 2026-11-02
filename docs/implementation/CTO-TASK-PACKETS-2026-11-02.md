# 자율 CTO 작업의 Task Packet 기반

2026-11-02. 사용자가 원하는 동작은 명세를 한 번 받은 CTO가 사용자의 반복적인
"계속해" 지시나 Lead 대화 없이 Worker를 만들고 작업·QA·수정을 완료까지 반복하는
것이다. 상주 모델이나 무한 CLI 반복기를 뜻하지 않는다. 이 요구는 v15 2G.6에
명문화했고, 이번에는 그 실행에 필요한 **CTO 작업 지시서**를 연결했다.

## 구현 범위

- `builder.read-task-packets`, `builder.publish-task-packet`을 CTO 도구로 등록했다.
  Core의 기존 scoped state/CAS journal, 실제 session request/run 조회를 재사용한다.
  다른 CTO, Lead 세션, 다른 Workspace, 취소/종료/퇴직 실행과 오래된 명세는 거부한다.
- CTO가 전달받은 현재 Workstream의 노드와 고정된 명세의 요구사항만 참조한다. 지시서는
  개발/QA 구분, 목표·범위·제외·제약·선행 작업·인수 기준·증거·재사용 근거를 포함한다.
  QA에는 CTO가 작성한 환경·절차·기대 결과·합격 기준이 필요하다. 다른 이름의
  Document Worker를 생성하거나 QA가 합격 기준을 스스로 낮추는 도구는 추가하지 않았다.
- 재사용 후보의 라이선스/호환성은 작성자의 근거 있는 보고 또는 미검토 상태다. 실제
  검토를 수행했다고 parser/저장 성공만으로 인정하지 않는다. HTTPS URL을 저장할 뿐
  자동 접속·다운로드·코드 실행은 하지 않는다. 자격정보 포함 URL은 거부한다.
- 지시서는48KiB, 보드는192KiB/64작업으로 제한한다. 정확한 필드·배열·Unicode·byte
  크기·범위·날짜·출처를 검증한다. 프로젝트/CTO/Workstream별 journal을 분리한다.
- 작업은 revision1부터 다음 버전으로 개정하고 과거 journal은 보존한다. 같은 작업/버전의
  같은 내용은 중복 저장하지 않고, 같은 버전의 다른 내용은 거부한다. 동시 게시 conflict나
  응답 유실은 조회로 확인하며 일반 set·자동 재송신·기록 삭제로 성공을 꾸미지 않는다.

## 선행 작업과 명세 변경

Task ID 의존성은 실제 보드에 존재하고 같은 명세 revision/digest를 사용해야 하며
순환을 허용하지 않는다. 서버는 각 의존성의 정확한 작업 revision과 canonical record
SHA-256을 `dependencyPins`에 저장한다. 선행 작업이 나중에 개정돼도 종속 지시서를
몰래 새 작업으로 바꾸지 않는다. 같은 revision의 pin은 hash까지 확인하고 과거 pin은
원래 참조로 남긴다. 실제 실행 연결 시에는 불변 journal의 해당 버전과 다시 대조해야 한다.

조회 결과에는 저장된 원본 보드와 `currentSource`, 작업별 `taskStates`를 구분한다.
명세 출처가 바뀌면 `historical`, 선행 작업의 pin이 달라지면 dependencies `changed`로
표시한다. `current`는 출처 일치라는 뜻이며 실행 권한, 준비 완료, Worker 완료가 아니다.
이 상태를 현재 UI의 가짜 진행률이나 실행 결과로 표시하는 화면은 만들지 않았다.

명세와 지시서 head는 서로 다른 키이므로 단일 원자 transaction이 아니다. CAS 직후
명세가 바뀌면 호출은 실패해도 게시된 이력이 남을 수 있다. 이를 rollback됐다고 주장하지
않고 다음 정상 전달에서 구판 기록으로 읽는다. 향후 실행 시에도 최신 권한/명세/pin
재확인이 필요하며 저장만으로 코드 실행을 허용하지 않는다.

## 실행 정책

기존 정확한2/4/6도구 CTO intent는 보존하고 새 전달만 Task Packet 두 도구를 포함한
정확한8도구 profile을 사용한다. 과거 requestId의 저장 정책을 확대하거나 재송신하지
않는다. 새 CTO prompt는 수신 확인 뒤 자기 작업 지시서를 복구·작성할 수 있다고
안내하지만 현재 Worker 실행/자동 continuation이 연결되지 않았음을 명시한다.
일반 Lead와 별도 질문/회신 turn에 CTO 지시서 권한을 추가하지 않았다.

Core에 Task/CTO/장기 목표 모델이나 새 DB·큐·스케줄러를 추가하지 않았다. **Worker
네이티브 실행, 실제 종료 이벤트를 통한 CTO 재개, 명시적 중지와 재시작 복원까지
입증해야 장기 자율 작업이 완성된다.** 현재 계획 저장으로 그 완료를 대신하지 않는다.

## 검사

Node24.22.1 격리 사본의 타입/빌드, 전체 **449/449**, SDK CLI validate/test 통과.
Task Packet domain10개·서비스10개와 정책/manifest 회귀를 포함한다. compiled Worker
JSONL fake Host 왕복에서 실제 등록 도구의 조회·게시·정확한 request/run 출처·Lead 거부를
확인했다. 이 검사는 실제 Core DB나 실제 AI의 Task Packet 작성이 아니다.

초기 검사의 테스트 fixture 타입 오류는 수정했다. 구판 root dist를 사용한 검사는 기존
도구 미등록/타임아웃으로 실패했고 새 코드의 통과 근거로 사용하지 않았다. pin 보강 뒤
검사에서는 아직 running인 옛 CTO를 둔 채 새 전달을 시도한 fixture2개와 늘어난 조회
DTO를 반영하지 않은 RPC assertion1개가 실패했다. 옛 run 종료를 명시적으로 관측하고
DTO 기대값을 수정했다. active-run 보호를 완화하거나 실패를 통과로 세지 않았다.

마지막 no-AI source Desktop 앱도449개/타입/빌드/SDK CLI 뒤 exit0이다. mock Identity와
실제 Host/UI bridge로 기존 권한·상태·Workspace 분리·재시작 및 질문 필터/읽기 전용
입력을 확인하고 화면을 검토했다. 질문 표시는 명시적 DTO fixture다. Main4/4 정상 종료,
출력8개 종료/실패0 및 내부 임시 데이터 제거를 확인했다. 기존 로컬 복구 harness는
새 Native LAN 시험이 아니다. 원시 로그·계정·실제 Workspace 식별자는 공개하지 않는다.

| 최종 시험 사본 | SHA-256 |
| --- | --- |
| source | `15a43f10192d85a41490abf7623ca4cebc9f33ab12e36bb25cb994a8bac9839a` |
| manifest | `5c54ac9cc9fb0f25b98aec14eeb5f87a61c6ea7d9b828543f8de514d613863ad` |
| Worker | `5d513159194cdfb4f944a4e6bcdab9a0e284a472d6bdf3d4c355721c8045f1ab` |
| SDK CLI UI 집계 | `49e2fc6c143e5f605c0ea328716a28c2fffcca9cbd25784ac5a2abd145a4933f` |
| 실제 Host UI index | `4974fa46d56889756d2835f0060e0a96744939bbac3012f31d1fa452c1736a0e` |

Core는 `6b74d808516e29dc389f784c49e32a4d31d2be71`, SDK는
`c69915a518f0eb600f0ace8238144059911f8d04` clean source다. 이번에 변경하지 않았다.
문서 후속 기록까지 시험 사본과 같은 source 지문이라고 주장하지 않는다. 재현은 비공개
Source Desktop에서 Node24/PATH24/npm_execpath/절대 SPS_BUILDER_SOURCE_ROOT로
`node scripts/smoke-builder-conditional-state-isolated.mjs`, live opt-in 없음이다.

이전 실제 AI 시험의 provider quota 실패 후 새 실제 AI 요청은 보내지 않았다. 계정·모델·
한도 우회도 없다. DEV 의존성/설치본/실제 데이터·Tailscale을 변경하지 않았고, 실행 중이던
예전 DEV PID가 없어진 것은 관측했지만 자동 검사 결과로 DEV가 실행 중이라고 주장하지
않는다. 사용자 환경의 다른 Electron 프로세스는 종료하지 않았다.

## 다음 단계

1. 검증된 Codex native Worker 경로에서 독립 세션·도구/파일/계정 권한·이력·취소 경계를
   확인하고 지시서의 정확한 버전을 전달한다. 미지원 API는 지원처럼 표시하지 않는다.
2. Core의 기존 이벤트/실행 조회·저장 원시 기능으로 Worker 결과를 현재 CTO의 후속
   실행에 연결한다. 중복/불확실한 전송·사용자 중지를 존중하고 재시작 후 복구한다.
3. CTO 검수·수정·독립 QA·실제 GitHub/Runner 증거와 Graph 실행 상태를 연결한다.
   기술 실행 성공과 요구사항 충족·납품은 분리한다.
4. 사용자 질문 답변의 Lead 공유 기억·설계 Revision·CTO 명세 개정 연결과 나머지 v15를
   완료한다. 위의 planning 도구 검사로 전체 AC를 PASS로 바꾸지 않는다.

Marketplace·Preview·새 Native LAN은 보류하고, 지원되지 않거나 보호가 입증되지 않은
생성 코드 실행을 자동 허용하지 않는다.

## 참고

[MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)의
입력·접근 제어와 [SQLite transaction 설명](https://www.sqlite.org/lang_transaction.html)을
검토했다. 기존 scoped state/CAS를 재사용하며 SQLite나 별도 저장소를 새로 도입하지
않았다. 외부 구현이나 비공개 Core 소스를 공개 Builder로 복사하지 않았다.
