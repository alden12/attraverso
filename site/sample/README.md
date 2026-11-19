# A sample plan spreadsheet, for trying the xlsx bridge

`plan.xlsx` is a small plan (the e2e fixture's demo, with a Next list) as the bridge reads it (`DIST-9.2`): Read me,
Items and Next sheets. Nothing here is real data.

**See it in the browser** (`DIST-9.1`): run `yarn workspace attraverso site`, open `/xlsx-bridge/` in Chrome or Edge,
and open this folder. The page shows the newest version of the plan in it and follows the folder, so an edit saved
from Excel (or written by an agent), or a new version saved beside it (`plan_v2.xlsx`), shows up within a couple of
seconds. `git checkout site/sample` puts it back.
