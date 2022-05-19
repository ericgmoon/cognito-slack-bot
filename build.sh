#!/bin/bash

tsc
cp src/config.json5 dist/config.json5
node util/json5_to_json.js dist/config.json5
rm dist/config.json5