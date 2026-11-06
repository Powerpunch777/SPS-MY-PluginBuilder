# Builder 역할 권한과 Core 범용 권한·Host 사전 위임

확정일: 2026-11-05. 출처: 이 대화에서 사용자가 직접 확정한 권한 정책.
제품 설계 결정이며, 아래 API·강제 기능이 현재 구현되어 있다는 선언은 아니다.
기존 v15·UI v9·CSAS v0.8·문서센터·Integration·최종 검토·승인 설계의 비충돌 요구를 유지한다.

## 1. 책임 경계

- Builder는 Lead, CTO, Worker, QA Worker, Integration Manager의 업무 역할과 역할별 권한 템플릿을 정의한다.
- Core는 Agent, CLI/Runner, 파일, 프로세스, Secret, Node, Workspace·Artifact, 네트워크의 범용 기술 권한을 발급·검증·관리·철회한다.
- Host 관리자는 Host·Workspace·Plugin·역할·Node·Runner별 허용 범위와 자동 실행 사전 위임을 승인·철회한다.
- 사용자는 주요 제품 설계 결정, 계약·가격 결정, 최종 납품 패키지 승인 등 업무상 최종 결정권을 보유한다.

Core에 Builder 전용 역할 이름이나 업무 Gate를 하드코딩하지 않는다. Builder의 역할 템플릿을
Core의 실제 범용 권한·위임 계약에 연결한다. 업무 역할 식별자만 전달하거나 caller boolean을
받았다는 이유로 기술 권한을 인정하지 않는다. 실제 실행 주체·현재 위임·범위와 검증 가능한
템플릿/작업 결속을 확인해야 한다. 구체적인 schema/API 이름은 기존 계약 조사 후 CTO가 정한다.

## 2. 역할별 업무 정책

| 역할 | 허용 업무 | 금지·분리 경계 |
| --- | --- | --- |
| Lead Main | 프로젝트 설계·상담·공통 기억 조회, 공식 설계 Revision 발행, CTO 작업 배정 | 사용자 승인 없는 계약·가격·최종 납품 확정 불가; 기존 설계 승인·변경관리 절차 유지 |
| Lead UI Design | 승인 설계 조회, UI 시안·UI Contract 작성 | 공식 제품 설계의 독단적 개정 불가 |
| Lead Background | 기술·OSS 조사, 재사용 검토, 작업 분할 준비, 허용된 조사 도구 실행 | 공식 설계 승인·코드 통합 불가 |
| Lead Question Intake | CTO 질문 접수, 승인 명세·허용된 상담 원문 검색, 명확한 근거가 있는 질문 해결 | 미승인 제품 동작 결정 불가 |
| Lead Question Discussion | 사용자 미결정사항 논의·실제 결정 접수, Main 개정 경로로 전달 | AI가 사용자 승인을 생성할 수 없음 |
| Lead Integration Review | 통합 결과·QA·납품 산출물 검토, 기존 최종 검토·승인 페이지 관리, 승인 요청 | 사용자를 대신한 최종 승인 불가; Main의 Packet/G7 적격 후보 경계 유지 |
| Integration Manager | CTO 검증 완료 이벤트 수신, 승인된 통합 브랜치 Git 작업, 통합 CI·E2E, 결과·Final Integration Packet 생성 | 공식 설계 변경·일반 Node 관리·최종 납품 승인 불가 |
| CTO | 배정된 Workstream 코드·기술 설계·테스트, 승인 범위의 Worker·QA 생성/배정, 담당 브랜치·작업 영역 수정/검증 | 다른 CTO 영역의 무단 수정·공식 설계 개정 불가 |
| Worker | 배정 Task 파일 수정·코드 작성·빌드·테스트, 허용된 CLI·Runner | 범위 밖 접근·무단 Agent 생성·임의 배포 불가 |
| QA Worker | 할당된 테스트 실행·증거 생성, 명시적으로 허용된 테스트 코드·설정 수정 | 공식 설계 개정·결과 조작·무단 통합 불가; 구현자 독립성과 대상 버전 결속 유지 |

Lead는 기존 여섯 논리 세션을 유지한다. Manager는 독립 Agent이며 Review용 Agent나 일곱 번째
Lead 세션을 추가하지 않는다. 역할 기본 권한은 전체 파일·다른 Agent 작업 영역의 포괄 권한이 아니다.
QA의 허용된 테스트/설정 수정도 원래 요구·기대값을 약화하거나 수정 전 결과를 수정 후 증거로
사용할 권한은 아니다. 실제 검증 대상·소유권·변경/동결·재검토 경계를 기록한다.

## 3. 네 단계의 권한 부여

1. 역할 기본 권한: Agent 생성 시 역할 템플릿에 따라 자동 부여한다. 실제 기술 권한의 상한과 현재 Host 정책을 넘지 않는다.
2. 작업별 임시 권한: 승인 Workstream·Task에 필요한 파일·CLI·프로세스 범위만 제한적으로 부여하고 작업 종료 시 회수한다.
3. Host 관리자 사전 위임: 특정 Host·Workspace·Plugin·역할·Node·Runner 범위의 자동 Agent 실행을 승인한다.
4. 사용자 전용 승인: 주요 제품 결정·계약·가격·최종 납품 확정은 AI에 위임하지 않는다.

승인된 범위 안의 CTO Worker 실행이나 Manager 통합 시도마다 사용자에게 같은 권한을 다시
묻지 않도록 한다. 반대로 사전 위임은 범위 확대, 다른 Workspace, 보호 자원 변경, 사용자 전용
결정을 우회하는 권한이 아니다. 기본 권한·임시 권한·위임·사용자 승인을 같은 상태로 합치지 않는다.

## 4. Manager 자동 실행과 수명주기

Host 관리자가 해당 Workspace·Plugin의 실행 범위를 사전 승인했다면 Agent별 수동 등록이나
새 CLI 인증 계정 추가 없이 독립 Manager를 실행할 수 있어야 한다. Agent 프로필·역할·세션·
작업 기록은 Lead와 분리하며 기본 프로필 생성과 이후 개별 설정을 지원한다.

기존 공용 CLI 인증 풀을 공유하고 Core가 실제 적격 프로필을 배정한다. 인증정보·Secret을
Builder나 Agent에 직접 노출하지 않는다. Lead 공급자/모델 설정은 초기값으로 재사용할 수 있지만
Agent 정체성·권한·세션·기록 또는 인증정보를 복제하지 않는다.

사전 위임은 Agent 실행 권한만 준다. 파일/Git 수정, 일반 Node 관리, 납품 승인 권한은 자동으로
주지 않는다. 실제 코드 통합·CI에는 기존 Core/SDK의 별도 기술 권한 검증이 필요하다.
승인된 CTO 완료 이벤트와 통합 작업 계약이 있어야 실행하며, 일반 메시지나 UI 상태로 대체하지 않는다.

위임의 만료·철회·동시 실행 한도·실행 이력을 관리한다. 철회·만료 후 신규 실행을 차단하고,
진행 중 실행은 실제 Core 정책과 실행환경을 통해 취소·종료한다. 종료 요청·관측된 종료·불확실을
구분한다. DB 상태를 failed로 바꾼 것만으로 프로세스 종료를 확인했다고 표시하지 않는다.
사용자/관리자가 일시정지한 Agent를 사전 위임만으로 무단 재활성화하지 않는다.

## 5. 범용 기술 권한과 실제 강제

기존 Core 계약을 먼저 재사용하고 필요한 부분만 범용 확장한다.

- Agent 생성·실행·중단·재개
- CLI/Runner 실행 및 인증 프로필 사용
- 경로별 파일 읽기·쓰기·삭제
- 프로세스 실행·종료
- Secret의 제한적 사용
- Node 실행·상태 조회
- Workspace 데이터·Artifact 조회·기록
- 허용된 네트워크 접근

모든 권한은 Workspace·Plugin·실행 주체·대상 자원·작업 범위·유효 기간에 따라 검증한다.
현재 권한·철회·상한을 실행 시작과 필요한 실제 효과 경계에서도 확인한다. Host 관리자 권한,
Plugin 실행 grant, Agent/Node/Runner grant를 서로 동의 없이 같은 것으로 취급하지 않는다.

Workspace ID와 Core API 검사는 CLI 프로세스의 OS 파일 접근을 자동 격리하지 않는다.
파일·프로세스·Secret 보호에는 실제 실행환경의 OS 접근 통제/샌드박스가 필요하다. 일반 OS 사용자,
shell:false, 고정 CLI, Job Object, fixture 또는 주입된 resolver만으로 보호 실행을 주장하지 않는다.
미지원/UNKNOWN/거부/실패/실제 종료를 구분하고 영구 UNKNOWN을 기능 완료로 삼지 않는다.

## 6. 구현·호환성·개발 운영

현재 Core/SDK의 실제 API·Grant·런타임·권한 계약을 조사하고 기존 검증을 재사용한다.
필요한 Core 수정은 Builder 전용 예외가 아닌 범용 확장안으로 분리해 영향과 호환성을 보고한다.
정책 확정이나 매니페스트 요청은 실제 Host 관리자 위임/권한 발급, 구현, QA의 증거가 아니다.
이 대화의 설계 승인을 가짜 Host 관리자 identity/grantor/Grant 행으로 변환하지 않는다.

Builder A는 업무 역할 템플릿·Lead 경계·공유 UI/매니페스트의 단일 편집 소유자다.
B는 Manager 업무 바인딩·통합/Gate/납품 서버 검증과 소비를 소유하고 A와 직접 계약을 맞춘다.
별도 native Core/SDK CTO가 중립 기술 계약·범용 위임·강제·호환성을 소유한다. Builder actor는
private Core를 복사·수정하지 않는다. 역할 기본값/설정/paused Agent 생성과 실제 실행을 구분한다.

최소 권한과 승인 범위 안의 자율성을 함께 검증한다. 정상 승인 범위에서는 반복 승인을 요구하지
않으면서, scope 확대·교차 Workspace·보호 자원·사용자 전용 결정은 직접 API에서도 막아야 한다.
현재 CAO의 Terra/Luna·YOLO·read-only QA 운영 지침은 제품 권한의 구현/OS 보장이 아니다.

## 7. 파생 검증 항목

후속 [장기목표 배정 권한](SPS_Builder_Delegated_Goals_And_Completion_Idle_Addendum_2026-11-05.md#2-배정-권한과-서버-강제)은
기존 템플릿/위임에 결속한다. Lead→담당 CTO, CTO→직속 Worker/QA만 배정하며 상위·형제·
교차 Workspace 목표 수정/clear/활성화는 직접 API에서도 차단한다. 자기 목표의 범위 확대도
새 상위 배정이 필요하다. Core는 범용 Goal 기술 권한과 대상/실행 주체를 관리하고 Builder
역할명은 하드코딩하지 않는다. 이 추가 권한이 이미 구현됐다는 뜻은 아니다.

다음 ID는 이 사용자 결정에서 도출한 검사 항목이다. 기존 216개 원문 AC 정의를 새 원문 AC로
재분류하거나 구현/합격 수를 늘리지 않는다. 최초 전체 정책 인수 상태는 모두 NOT_RUN이다.

| 파생 ID | 검증 범위 |
| --- | --- |
| POLICY-AUTH-01 | Builder 역할/업무 정책과 Core 범용 기술 권한 분리, Core에 Builder 역할 하드코딩 없음 |
| POLICY-AUTH-02 | Lead 여섯 세션의 각각의 조회·작성·공식 발행·질문·승인 경계 |
| POLICY-AUTH-03 | CTO Workstream/Worker Task/QA 테스트·설정의 최소 범위와 독립 검증 |
| POLICY-AUTH-04 | 기본 권한·임시 권한·Host 위임·사용자 전용 승인 분리와 작업 종료 회수 |
| POLICY-AUTH-05 | Host/Workspace/Plugin/주체/역할 템플릿/Node/Runner/자원/작업/기간 결속 |
| POLICY-AUTH-06 | 실제 Host 관리자 발급·승인·철회와 범위 확대·교차 Workspace 거부 |
| POLICY-AUTH-07 | 독립 Manager 프로필·역할·세션·기록, 기본 생성·개별 설정·수동 등록 불필요 |
| POLICY-AUTH-08 | 기존 적격 CLI 공용 풀의 Core 배정과 인증정보·Secret 비노출 |
| POLICY-AUTH-09 | 승인 CTO 이벤트·통합 계약으로만 실행, 파일/Git/CI/Node 권한 별도 검증 |
| POLICY-AUTH-10 | 만료·철회·동시 실행 한도·이력, 신규 차단과 진행 실행 취소/종료/불확실 |
| POLICY-AUTH-11 | 범위 내 반복 승인 없음과 미승인 확대·보호 자원 변경 차단 |
| POLICY-AUTH-12 | 실제 OS 파일/프로세스/Secret/자손 보호와 API 검사만으로 격리 주장 금지 |
| POLICY-AUTH-13 | 사용자 제품·계약·가격·최종 납품 결정은 어떤 Agent/위임으로도 대행 불가 |
| POLICY-AUTH-14 | 기존 Core/SDK 호환성, 미구현 상태 보존, 실제 앱/AI/실기기 검증 범위 분리 |

