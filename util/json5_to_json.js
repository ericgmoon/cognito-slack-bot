const json5 = require("json5");
const fs = require("fs");

fs.writeFileSync(process.argv[2].replace(".json5", ".json"), JSON.stringify(json5.parse(fs.readFileSync(process.argv[2]).toString())));