const BaseTool = require('../lib/baseTool');
const axios = require('axios');

class WeatherTool extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'weather';
    this.description = 'Get current weather information and forecasts when user EXPLICITLY requests weather, temperature, forecast, or climate data for a specific location. Use ONLY when user asks about weather conditions, temperature, or forecasts. DO NOT use for general location questions or casual conversation.';
    this.category = 'information';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent';
    this.priority = 20;

    this.parameters = {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'The city name to get weather for'
        },
        date: {
          type: 'string',
          description: 'Date for weather forecast (YYYY-MM-DD or descriptive date)'
        },
        units: {
          type: 'string',
          description: 'Temperature units (metric or imperial)',
          enum: ['metric', 'imperial'],
          default: 'metric'
        }
      },
      required: ['city']
    };
  }

  // SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
  // DO NOT use keyword matching - let Gemini's function calling handle triggering
  async shouldTrigger() {
    return false; // Let Gemini handle all triggering via description
  }

  async execute(params, toolContext = {}) {
    try {
      const { city, date, units = 'metric' } = params;
      
      // Extract context information
      const messageData = toolContext.messageData || toolContext;
      const knowledgeResults = toolContext.knowledgeResults;
      
      // Try to extract date from knowledge base if not provided
      let weatherDate = date;
      if (!weatherDate && knowledgeResults) {
        for (const result of knowledgeResults) {
          // Look for date patterns in knowledge base content
          const dateMatch = result.content.match(/(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
          if (dateMatch) {
            const monthName = dateMatch[0].split(/\s+/)[0].toLowerCase();
            const monthNumber = this.getMonthNumber(monthName);
            const day = dateMatch[1].padStart(2, '0');
            const year = dateMatch[2];
            weatherDate = `${year}-${monthNumber.padStart(2, '0')}-${day}`;
            this.log('info', 'Extracted date from knowledge base', {
              extractedDate: weatherDate,
              fromDocument: result.title,
              originalText: dateMatch[0]
            });
            break;
          }
        }
      }

      // Note: This is a mock implementation
      // In production, you would use a real weather API like OpenWeatherMap
      const mockWeatherData = {
        city: city,
        date: weatherDate || 'current',
        temperature: units === 'metric' ? '22°C' : '72°F',
        condition: 'Partly Cloudy',
        humidity: '65%',
        windSpeed: units === 'metric' ? '15 km/h' : '9 mph'
      };

      // Adjust mock data based on date (if November, make it cooler)
      if (weatherDate && weatherDate.includes('-11-')) {
        mockWeatherData.temperature = units === 'metric' ? '8°C' : '46°F';
        mockWeatherData.condition = 'Cool and Partly Cloudy';
      }

      const response = `🌤️ Weather in ${mockWeatherData.city}${weatherDate ? ` for ${weatherDate}` : ''}:
Temperature: ${mockWeatherData.temperature}
Condition: ${mockWeatherData.condition}
Humidity: ${mockWeatherData.humidity}
Wind Speed: ${mockWeatherData.windSpeed}

Note: This is a demo response. Configure with a real weather API for actual data.`;

      // Log the tool usage
      this.log('info', 'Weather request processed', {
        city,
        date: weatherDate,
        units,
        hasKnowledgeContext: !!knowledgeResults,
        userId: messageData.userId
      });

      return response;
    } catch (error) {
      this.log('error', 'Weather tool failed', {
        error: error.message,
        params
      });
      throw new Error('Failed to get weather information');
    }
  }

  getMonthNumber(monthName) {
    const months = {
      'january': '1', 'jan': '1',
      'february': '2', 'feb': '2',
      'march': '3', 'mar': '3',
      'april': '4', 'apr': '4',
      'may': '5',
      'june': '6', 'jun': '6',
      'july': '7', 'jul': '7',
      'august': '8', 'aug': '8',
      'september': '9', 'sep': '9',
      'october': '10', 'oct': '10',
      'november': '11', 'nov': '11',
      'december': '12', 'dec': '12'
    };
    return months[monthName.toLowerCase()] || '1';
  }
}

module.exports = WeatherTool;