const axios = require('axios');
const { logger } = require('../utils/logger');
const config = require('../config/env');

// This endpoint handles the Local Application installation iframe
async function handleLocalAppInstall(req, res) {
  try {
    // Allow iframe embedding from Bitrix24
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');

    logger.info('Local Application install page requested', {
      query: req.query,
      body: req.body
    });

    // Check if we have AUTH_ID (means app is being opened/installed)
    if (req.body?.AUTH_ID) {
      const authId = req.body.AUTH_ID;
      const refreshId = req.body.REFRESH_ID;
      const domain = req.query.DOMAIN || req.body.DOMAIN;

      // Construct REST endpoint
      const restEndpoint = `https://${domain}/rest/`;

      // HTML page with auto-registration script
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Chantilly AI Agent Installation</title>
  <script src="//api.bitrix24.com/api/v1/"></script>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; }
    .status { margin: 20px 0; padding: 15px; border-radius: 5px; }
    .success { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
    .info { background: #d1ecf1; color: #0c5460; }
    button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Chantilly AI Agent Installation</h1>
  <div id="status" class="status info">Initializing...</div>

  <script>
    console.log('Starting BX24 initialization...');

    // Add timeout for initialization
    let initTimeout = setTimeout(function() {
      document.getElementById('status').className = 'status error';
      document.getElementById('status').innerHTML = 'Failed to initialize. Please ensure you are accessing this through Bitrix24.<br>Check browser console for details.';
    }, 5000);

    // Check if BX24 is available
    if (typeof BX24 === 'undefined') {
      document.getElementById('status').className = 'status error';
      document.getElementById('status').innerHTML = 'BX24 SDK not loaded. Please check your connection.';
    } else {
      BX24.init(function(){
        clearTimeout(initTimeout);
        console.log('BX24 initialized successfully');
        document.getElementById('status').innerHTML = 'Registering Chantilly bot...';

        // First check if bot already exists
      BX24.callMethod(
        'imbot.bot.list',
        {},
        function(listResult) {
          if(listResult.error()) {
            document.getElementById('status').className = 'status error';
            document.getElementById('status').innerHTML = 'Error listing bots: ' + listResult.error();
            return;
          }

          var bots = listResult.data();
          var existingBot = null;
          for(var id in bots) {
            if(bots[id].CODE === 'Chantilly_AI_AGENT') {
              existingBot = bots[id];
              break;
            }
          }

          if(existingBot) {
            // Bot exists, update it
            document.getElementById('status').innerHTML = 'Updating existing bot...';
            BX24.callMethod(
              'imbot.update',
              {
                BOT_ID: existingBot.ID,
                OPENLINE: 'N',
                FIELDS: {
                  EVENT_MESSAGE_ADD: '${CLOUD_RUN_SERVICE_URL}/webhook/bitrix24',
                  EVENT_WELCOME_MESSAGE: '${CLOUD_RUN_SERVICE_URL}/webhook/bitrix24',
                  EVENT_BOT_DELETE: '${CLOUD_RUN_SERVICE_URL}/webhook/bitrix24',
                  PROPERTIES: {
                    NAME: 'Chantilly Agent',
                    LAST_NAME: 'Gemini',
                    COLOR: 'BLUE',
                    WORK_POSITION: 'AI Assistant for Chats & Open Channels',
                    PERSONAL_WWW: '${CLOUD_RUN_SERVICE_URL}'
                  }
                }
              },
              function(updateResult) {
                if(updateResult.error()) {
                  document.getElementById('status').className = 'status error';
                  document.getElementById('status').innerHTML = 'Update error: ' + updateResult.error();
                } else {
                  document.getElementById('status').className = 'status success';
                  document.getElementById('status').innerHTML =
                    '<strong>✅ Bot updated successfully!</strong><br>' +
                    'Bot ID: ' + existingBot.ID + '<br><br>' +
                    'Event handlers have been configured.<br>' +
                    'Chantilly AI Agent is ready to respond to messages!';
                }
              }
            );
          } else {
            // Register new bot
            document.getElementById('status').innerHTML = 'Registering new Chantilly bot...';
            BX24.callMethod(
              'imbot.register',
              {
                CODE: 'Chantilly_AI_AGENT',
                TYPE: 'B',
                OPENLINE: 'N',
                EVENT_MESSAGE_ADD: '${CLOUD_RUN_SERVICE_URL}/webhook/bitrix24',
                EVENT_WELCOME_MESSAGE: '${CLOUD_RUN_SERVICE_URL}/webhook/bitrix24',
                EVENT_BOT_DELETE: '${CLOUD_RUN_SERVICE_URL}/webhook/bitrix24',
                PROPERTIES: {
                  NAME: 'Chantilly Agent',
                  LAST_NAME: 'Gemini',
                  COLOR: 'BLUE',
                  WORK_POSITION: 'AI Assistant for Chats & Open Channels',
                  PERSONAL_WWW: '${CLOUD_RUN_SERVICE_URL}'
                }
              },
        function(result) {
          if(result.error()) {
            document.getElementById('status').className = 'status error';
            document.getElementById('status').innerHTML = 'Error: ' + result.error();
          } else {
            var botId = result.data();
            document.getElementById('status').className = 'status success';
            document.getElementById('status').innerHTML =
              '<strong>✅ Bot registered successfully!</strong><br>' +
              'Bot ID: ' + botId + '<br><br>' +
              'Chantilly AI Agent is now active and ready to respond to messages.<br><br>' +
              'You can close this window and start chatting with Chantilly!';
          }
        }
            );
          }
        }
      );
    });
    }
  </script>
</body>
</html>`;

      res.send(html);
    } else {
      // No auth, show info page
      res.send(`
        <h1>Chantilly AI Agent</h1>
        <p>This page should be accessed through Bitrix24 Local Application.</p>
      `);
    }
  } catch (error) {
    logger.error('Failed to handle Local App install', error);
    res.status(500).send('Installation failed');
  }
}

module.exports = { handleLocalAppInstall };