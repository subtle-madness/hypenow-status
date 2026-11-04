# 하입나우 서비스 상태

공개 상태 페이지: https://status.hypenow.io

GitHub Actions가 5분마다 아래 주소에 바깥에서 접속해 정상 여부를 기록하고, GitHub Pages에 상태 페이지를 올린다.
우리 서버(오라클)와 따로 돌기 때문에 서버가 통째로 죽어도 이 페이지는 열린다. 설정은 [`.upptimerc.yml`](.upptimerc.yml) 하나다.

| 표시 이름 | 점검 주소 | 의미 |
| --- | --- | --- |
| 웹사이트 | `https://www.hypenow.io` | 화면이 열리는지 |
| 서비스 서버 | `https://api.hypenow.io/health` | 서버 프로그램이 살아 있는지(DB 미확인) |
| 데이터 조회 | `https://api.hypenow.io/v1/stats` | 서버에서 DB까지 읽히는지 |

## 운영 방법

- **장애 자동 감지**: 점검이 실패하면 2번 더 확인한 뒤 장애 이슈가 자동으로 열리고, 복구되면 자동으로 닫힌다.
  자동 이슈 제목은 영어(`🛑 서비스 서버 is down`)로 고정이라, 고객에게 보일 문구로 제목을 고쳐 둔다.
- **장애 공지 직접 올리기**: Issues → New issue → "장애 공지" 양식. 라벨 `status`가 붙어야 페이지에 뜬다.
  소식은 댓글로 이어 쓰고, 해결되면 이슈를 닫는다.
- **점검 예고**: "정기 점검 예정" 양식. 시각은 UTC로 쓴다.
- **5분 주기 한계**: GitHub 예약 실행은 바쁠 때 몇 분씩 밀릴 수 있다. 팀이 즉시 받는 알림은 기존 Discord 알림이 맡는다.

<!--start: status pages-->
<!--end: status pages-->

<!--start: docs-->
<!--end: docs-->

[Upptime](https://upptime.js.org)(MIT) 기반.
