#!/bin/zsh
# The "scheduled post draft" app level done with exact aqb commands (no decision model), the way a driving agent
# scripts a known flow. Prints the elapsed time and the fixture's end state.
#   zsh bench/scripted.sh
set -e
zmodload zsh/datetime
cd ${0:A:h}/..
aqb() { bun src/index.ts --session scripted "$@" }
start=$EPOCHREALTIME
aqb navigate "file://$PWD/bench/fixtures/studio.html"
aqb upload --match 'button "Select video' bench/fixtures/clip.mp4
aqb wait --match 'Uploaded'
aqb type --match 'textbox "Description' 'Missed mate in one?! Would you have seen it? #chess #chesstok #fyp'
aqb click --match 'radio "Schedule'
aqb click --match 'textbox "Time'
aqb click --match 'span "17 \| in column 1'
aqb click --match 'span "00 \| in column 2'
aqb click --match 'button "Show more'
aqb click --match 'switch "AI-generated content'
printf 'elapsed: %.1fs\n' $(( EPOCHREALTIME - start ))
bun -e 'import * as tab from "./src/tab.ts"; console.log(JSON.stringify(await tab.withSession("scripted", () => tab.evaluateExpression("window.benchState()"))))'
aqb close
