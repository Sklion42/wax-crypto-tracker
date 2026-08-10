'use strict';

// Publish the slash commands without starting the bot.
// Usage: npm run register

require('dotenv').config({ quiet: true });

const { assertValid } = require('../src/config');
const { registerCommands } = require('../src/registerCommands');
const log = require('../src/logger');

(async () => {
    try {
        assertValid();
        await registerCommands();
    } catch (err) {
        log.error(err.message);
        process.exit(1);
    }
})();
