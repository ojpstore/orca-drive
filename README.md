# Google Drive

Orca 오른쪽 사이드바에서 Google Drive를 쓰는 플러그인입니다. 패널(`panel/index.html`)이 화면과 드래그 앤 드롭을 맡고, worker(`worker.mjs`)가 OAuth 로그인과 Drive REST v3 호출을 맡습니다. 외부 의존성은 없습니다.

## 기능

- **탐색**: 폴더를 더블클릭하면 들어가고, 위쪽 경로를 누르거나 Backspace를 누르면 상위 폴더로 갑니다.
- **파일 열기**: 파일을 더블클릭하면 기본 브라우저에서 Drive 화면(`webViewLink`)으로 엽니다.
- **업로드**: 탐색기에서 파일을 패널에 끌어다 놓으면 지금 폴더로, 폴더 행이나 경로 조각 위에 놓으면 그 폴더로 올라갑니다(1 MiB 조각, 재개 가능 업로드).
- **이동**: 목록의 항목을 폴더 행이나 경로 조각으로 끌어다 놓습니다.
- **폴더 생성**: `＋폴더` → 이름 입력 후 Enter.
- **삭제**: 항목 선택 후 `삭제`(또는 Delete 키)를 두 번 누릅니다. 영구 삭제가 아니라 **휴지통**으로 보내므로 Drive에서 30일 안에 복구할 수 있습니다.

## 처음 설정

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들고 **Google Drive API**를 사용 설정합니다.
2. OAuth 동의 화면을 설정합니다(외부, 테스트 모드면 본인 계정을 테스트 사용자로 추가).
3. 사용자 인증 정보 → **OAuth 클라이언트 ID**, 유형 **데스크톱 앱**으로 만듭니다.
4. 패널에 Client ID와 Client secret을 넣고 저장 → **Google 계정으로 로그인**.

로그인은 PKCE + `127.0.0.1` 임의 포트 리디렉션(데스크톱 앱 방식)으로 하며, 클라이언트 값과 refresh token은 Orca 암호화 저장소(`secrets:own`)에 둡니다. 범위는 기존 파일을 다루기 위해 `drive` 전체입니다. 앱이 검증 전이라 Google이 "확인되지 않은 앱" 경고를 보이면 **고급 → 이동**으로 진행합니다.

## 개발

```sh
node --test worker.test.mjs
orca plugin validate .
orca plugin dev watch .                      # 처음 로드 때 --approve 필요
orca plugin dev request . drive.list --data '{"parent":"root"}'
```
