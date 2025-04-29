// MatrixRPGClient.js
import { createClient } from 'matrix-js-sdk';

export class MatrixRPGClient {
  constructor() {
    this.client = null;
    this.baseUrl = 'https://matrix.org';
    this.room = null; // Single room for both game and chat
    this.listeners = {
      message: [],
      roll: [],
      login: [],
      error: [],
      roomJoin: [],
      roomLeave: [],
      roomState: [],
      scene: [],
      narrate: []  // Add narrate event listener
    };
    this.roomState = {};
    this.userId = null;
    
    // NEW: Cache for messages to preserve history across sessions
    this.messageCache = {};
    this.isLoadingHistory = false;
    this.historyLoaded = false;
    
    // Load saved room and message cache
    this.room = localStorage.getItem('matrixRoom');
    this._loadMessageCache();
  }

  // NEW: Methods for preserving message history
  _loadMessageCache() {
    try {
      const cachedData = localStorage.getItem('matrixMessageCache');
      if (cachedData) {
        this.messageCache = JSON.parse(cachedData);
      }
    } catch (error) {
      console.error('Error loading message cache:', error);
      this.messageCache = {};
    }
  }

  _saveMessageCache() {
    try {
      localStorage.setItem('matrixMessageCache', JSON.stringify(this.messageCache));
    } catch (error) {
      console.error('Error saving message cache:', error);
      // If storage quota exceeded, prune older messages
      if (error.name === 'QuotaExceededError') {
        this._pruneMessageCache();
        try {
          localStorage.setItem('matrixMessageCache', JSON.stringify(this.messageCache));
        } catch (e) {
          console.error('Failed to save even after pruning:', e);
        }
      }
    }
  }

  _pruneMessageCache() {
    // For each room, keep only the most recent 1000 messages
    Object.keys(this.messageCache).forEach(roomId => {
      const messages = this.messageCache[roomId];
      if (messages.length > 1000) {
        this.messageCache[roomId] = messages.slice(messages.length - 1000);
      }
    });
  }

  _addMessageToCache(roomId, message) {
    if (!this.messageCache[roomId]) {
      this.messageCache[roomId] = [];
    }
    
    // Check if message already exists in cache by ID
    const exists = this.messageCache[roomId].some(m => m.id === message.id);
    if (!exists) {
      this.messageCache[roomId].push(message);
      this._saveMessageCache();
    }
  }

  _getMessageCache(roomId) {
    return this.messageCache[roomId] || [];
  }

  // Authentication
  async login(username, password) {
    try {
      this.client = createClient({
        baseUrl: this.baseUrl
      });
      
      const loginResponse = await this.client.loginWithPassword(username, password);
      this.userId = loginResponse.user_id;
      
      localStorage.setItem('matrixAccessToken', loginResponse.access_token);
      localStorage.setItem('matrixUserId', loginResponse.user_id);
      localStorage.setItem('matrixUsername', username);
      localStorage.setItem('matrixPassword', password); // Note: Consider more secure storage
      
      this.setupClientListeners();
      await this.client.startClient();
      
      // Store the saved room ID but don't auto-join
      this.room = localStorage.getItem('matrixRoom');
      
      // Return login result directly instead of triggering event
      return { success: true, userId: loginResponse.user_id };
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'login', 
        message: error.message || 'Login failed' 
      });
      return { success: false };
    }
  }

  async loginWithToken() {
    const token = localStorage.getItem('matrixAccessToken');
    const userId = localStorage.getItem('matrixUserId');
    
    if (!token || !userId) {
      // Try username/password if token fails
      const username = localStorage.getItem('matrixUsername');
      const password = localStorage.getItem('matrixPassword');
      
      if (username && password) {
        return this.login(username, password);
      }
      
      return false;
    }

    try {
      this.client = createClient({
        baseUrl: this.baseUrl,
        accessToken: token,
        userId: userId
      });

      this.userId = userId;
      this.setupClientListeners();
      await this.client.startClient();
      
      // Important: DON'T auto-join rooms even if we have saved room ID
      // We'll just save the room ID for later but not join automatically
      this.room = localStorage.getItem('matrixRoom');
      
      return true;
    } catch (error) {
      // Try username/password if token fails
      const username = localStorage.getItem('matrixUsername');
      const password = localStorage.getItem('matrixPassword');
      
      if (username && password) {
        return this.login(username, password);
      }
      
      this._triggerEvent('error', { 
        context: 'tokenLogin', 
        message: error.message || 'Token login failed' 
      });
      return false;
    }
  }

  logout() {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }
    localStorage.removeItem('matrixAccessToken');
    localStorage.removeItem('matrixUserId');
    localStorage.removeItem('matrixUsername');
    localStorage.removeItem('matrixPassword');
    localStorage.removeItem('matrixRoom');
    this.userId = null;
    this.room = null;
    this.roomState = {};
    // We don't clear message cache on logout to preserve history
  }

  // Room management
  async joinRoom(roomIdOrAlias, inviteCode = null) {
    if (!this.client) {
      this._triggerEvent('error', { 
        context: 'joinRoom', 
        message: 'Not logged in' 
      });
      return false;
    }

    try {
      const joinOptions = inviteCode ? { inviteSigningKey: inviteCode } : undefined;
      const room = await this.client.joinRoom(roomIdOrAlias, joinOptions);
      this.room = room.roomId;
      localStorage.setItem('matrixRoom', room.roomId);
      
      // Initialize room state
      await this._updateRoomState(room.roomId);
      
      // First load cached messages if available
      const cachedMessages = this._getMessageCache(room.roomId);
      
      if (cachedMessages.length > 0) {
        // Process cached messages
        cachedMessages.forEach(msg => {
          this._processHistoricalMessage(msg);
        });
      }
      
      // Then load room history from server
      this.isLoadingHistory = true;
      await this._loadRoomHistory(room.roomId);
      this.isLoadingHistory = false;
      this.historyLoaded = true;
      
      this._triggerEvent('roomJoin', { 
        roomId: room.roomId,
        name: room.name
      });
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'joinRoom', 
        message: error.message || 'Failed to join room' 
      });
      return false;
    }
  }

  // IMPROVED: Better history loading with pagination
  async _loadRoomHistory(roomId) {
    if (!this.client) return false;
    
    try {
      const room = this.client.getRoom(roomId);
      if (!room) return false;
      
      // Signal we're loading history
      this._triggerEvent('message', {
        sender: 'system',
        roomId,
        text: "Loading message history...",
        type: 'system',
        system: true
      });
      
      // Store processed events to avoid duplicates
      const processedEvents = new Set();
      
      // Function to process and cache events
      const processEvents = (events) => {
        let newEvents = 0;
        
        events.forEach(event => {
          const eventId = event.getId();
          
          // Skip processed or redacted events
          if (processedEvents.has(eventId) || event.isRedacted()) return;
          
          processedEvents.add(eventId);
          
          if (event.getType() === 'm.room.message') {
            const content = event.getContent();
            const sender = event.getSender();
            const timestamp = event.getTs();
            
            // Get power level
            let powerLevel = 0;
            if (this.roomState[roomId] && 
                this.roomState[roomId].members && 
                this.roomState[roomId].members[sender]) {
              powerLevel = this.roomState[roomId].members[sender].powerLevel;
            }
            
            // Determine message type
            const messageType = content.formatted_body?.type || 'chat'; // Default to chat
            
            // Prepare message object for caching
            const messageObj = {
              id: eventId,
              sender,
              roomId,
              text: content.body,
              type: messageType,
              powerLevel,
              timestamp,
              historical: true
            };
            
            // Add specific fields based on message type
            if (messageType === 'roll' && content.format === 'org.matrix.custom.rpg') {
              messageObj.dice = content.formatted_body.dice;
              messageObj.rolls = content.formatted_body.rolls;
              messageObj.hits = content.formatted_body.hits;
              messageObj.highEvenOdd = content.formatted_body.highEvenOdd;
              messageObj.lowEvenOdd = content.formatted_body.lowEvenOdd;
              messageObj.username = content.formatted_body.username;
            } else if (messageType === 'scene' && content.format === 'org.matrix.custom.rpg') {
              messageObj.sceneName = content.formatted_body.sceneName;
              messageObj.sceneType = content.formatted_body.sceneType;
            }
            
            // Cache the message
            this._addMessageToCache(roomId, messageObj);
            
            // Process the message to display it
            this._processHistoricalMessage(messageObj);
            
            newEvents++;
          }
        });
        
        return newEvents;
      };
      
      // Initial timeline events
      const timeline = room.getLiveTimeline().getEvents();
      processEvents(timeline);
      
      // IMPROVED: More reliable pagination using Matrix SDK's getRoomEvents
      const paginateBackward = async (limit = 100) => {
        try {
          // Create filter for message events only
          const filter = {
            types: ['m.room.message'],
            limit: limit,
            rooms: [roomId]
          };
          
          // Get older events from the server
          const response = await this.client.createMessagesRequest(
            roomId, 
            null, // No token means start from most recent
            limit,
            'b' // backward
          );
          
          if (!response || !response.chunk || response.chunk.length === 0) {
            // No more history to load
            this._triggerEvent('message', {
              sender: 'system',
              roomId,
              text: "All message history loaded",
              type: 'system',
              system: true,
              temporary: true
            });
            return false;
          }
          
          // Convert raw events to actual MatrixEvent objects
          const events = response.chunk.map(e => {
            const event = this.client.getEventMapper()(e);
            return event;
          });
          
          const newEvents = processEvents(events);
          
          // If we got new events and there are more to load (token exists)
          if (response.end && newEvents > 0) {
            // Continue pagination with delay to prevent rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
            return await paginateBackward(limit);
          }
          
          return false;
        } catch (error) {
          console.error('Pagination error:', error);
          
          // Handle rate limiting
          if (error.errcode === 'M_LIMIT_EXCEEDED') {
            const retryAfter = error.data?.retry_after_ms || 5000;
            await new Promise(resolve => setTimeout(resolve, retryAfter));
            return await paginateBackward(limit);
          }
          
          this._triggerEvent('message', {
            sender: 'system',
            roomId,
            text: "Couldn't load more history: " + (error.message || 'Unknown error'),
            type: 'system',
            system: true,
            temporary: true
          });
          
          return false;
        }
      };
      
      // Start pagination process
      await paginateBackward();
      
      return true;
    } catch (error) {
      console.error('Error loading room history:', error);
      
      this._triggerEvent('message', {
        sender: 'system',
        roomId,
        text: "Error loading history: " + (error.message || 'Unknown error'),
        type: 'system',
        system: true,
        temporary: true
      });
      
      return false;
    }
  }

  // NEW: Process historical messages
  _processHistoricalMessage(msg) {
    // Skip if this is during initial history loading
    if (this.isLoadingHistory && !msg.important) return;
    
    // Determine the type of message and trigger the appropriate event
    if (msg.type === 'roll') {
      this._triggerEvent('roll', msg);
    } else if (msg.type === 'scene') {
      this._triggerEvent('scene', msg);
    } else {
      // For regular, narration, and system messages
      this._triggerEvent('message', msg);
    }
  }

  async _updateRoomState(roomId) {
    try {
      const powerLevels = await this.client.getStateEvent(roomId, 'm.room.power_levels');
      const membersResponse = await this.client.getJoinedRoomMembers(roomId);
      const members = Object.keys(membersResponse.joined || {}).map(userId => ({ userId }));
      
      // Store room state
      this.roomState[roomId] = {
        members: {},
        powerLevels: powerLevels
      };
      
      // Store member power levels
      members.forEach(member => {
        const userId = member.userId;
        const powerLevel = powerLevels.users[userId] || 0;
        
        this.roomState[roomId].members[userId] = {
          powerLevel: powerLevel
        };
      });
      
      this._triggerEvent('roomState', { 
        roomId,
        state: this.roomState[roomId]
      });
      
      return this.roomState[roomId];
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'roomState', 
        message: error.message || 'Failed to update room state' 
      });
      return null;
    }
  }

  // Messaging
  async sendMessage(text, type = 'chat') {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'sendMessage', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      // Send message with custom format to indicate type
      const response = await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: type // 'game' or 'chat'
        }
      });
      
      // Cache our own message immediately
      const messageObj = {
        id: response.event_id,
        sender: this.userId,
        roomId: this.room,
        text: text,
        type: type,
        powerLevel: this.roomState[this.room]?.members[this.userId]?.powerLevel || 0,
        timestamp: Date.now(),
        self: true // Mark as our own message
      };
      
      this._addMessageToCache(this.room, messageObj);
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'sendMessage', 
        message: error.message || 'Failed to send message' 
      });
      return false;
    }
  }
  
  // Scene creation
  async sendScene(sceneName, sceneType = 'regular') {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'sendScene', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      // Format the scene message
      const sceneText = `${sceneName}`;
      
      // Send as a special scene message
      const response = await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: sceneText,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: "scene",
          sceneName: sceneName,
          sceneType: sceneType
        }
      });
      
      // Cache our own scene immediately
      const sceneObj = {
        id: response.event_id,
        sender: this.userId,
        roomId: this.room,
        text: sceneText,
        type: 'scene',
        sceneName: sceneName,
        sceneType: sceneType,
        powerLevel: this.roomState[this.room]?.members[this.userId]?.powerLevel || 0,
        timestamp: Date.now(),
        self: true
      };
      
      this._addMessageToCache(this.room, sceneObj);
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'sendScene', 
        message: error.message || 'Failed to send scene' 
      });
      return false;
    }
  }
  
  // Narration
  async sendNarration(text) {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'sendNarration', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      // Send as a special narration message
      const response = await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: "narrate"
        }
      });
      
      // Cache our own narration immediately
      const narrationObj = {
        id: response.event_id,
        sender: this.userId,
        roomId: this.room,
        text: text,
        type: 'narrate',
        powerLevel: this.roomState[this.room]?.members[this.userId]?.powerLevel || 0,
        timestamp: Date.now(),
        self: true
      };
      
      this._addMessageToCache(this.room, narrationObj);
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'sendNarration', 
        message: error.message || 'Failed to send narration' 
      });
      return false;
    }
  }
  
  // Message handling
  async deleteLastMessage() {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'deleteMessage', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      const room = this.client.getRoom(this.room);
      if (!room) return false;
      
      // Get timeline events
      const timeline = room.getLiveTimeline().getEvents();
      
      // Find last message sent by current user
      let lastMessageEvent = null;
      for (let i = timeline.length - 1; i >= 0; i--) {
        const event = timeline[i];
        if (event.getType() === 'm.room.message' && event.getSender() === this.userId) {
          lastMessageEvent = event;
          break;
        }
      }
      
      if (!lastMessageEvent) {
        // If not found in timeline, check cache for our last message
        if (this.messageCache[this.room]) {
          const userMessages = this.messageCache[this.room]
            .filter(msg => msg.sender === this.userId)
            .sort((a, b) => b.timestamp - a.timestamp);
          
          if (userMessages.length > 0) {
            lastMessageEvent = { getId: () => userMessages[0].id };
          }
        }
        
        if (!lastMessageEvent) {
          this._triggerEvent('error', { 
            context: 'deleteMessage', 
            message: 'No messages found to delete' 
          });
          return false;
        }
      }
      
      // Redact the message
      await this.client.redactEvent(this.room, lastMessageEvent.getId());
      
      // Update cache to mark as redacted
      if (this.messageCache[this.room]) {
        this.messageCache[this.room] = this.messageCache[this.room].map(msg => {
          if (msg.id === lastMessageEvent.getId()) {
            return { ...msg, redacted: true };
          }
          return msg;
        });
        this._saveMessageCache();
      }
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'deleteMessage', 
        message: error.message || 'Failed to delete message' 
      });
      return false;
    }
  }
  
  async clearAllMessages() {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'clearMessages', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      const room = this.client.getRoom(this.room);
      if (!room) return false;
      
      // Get timeline events
      const timeline = room.getLiveTimeline().getEvents();
      
      // Find all messages sent by current user
      const userEvents = [];
      for (let i = 0; i < timeline.length; i++) {
        const event = timeline[i];
        if (event.getType() === 'm.room.message' && event.getSender() === this.userId) {
          userEvents.push(event);
        }
      }
      
      // Check cache for additional messages
      if (this.messageCache[this.room]) {
        const cachedUserMessages = this.messageCache[this.room]
          .filter(msg => msg.sender === this.userId && !msg.redacted);
        
        // Add IDs not already in userEvents
        const eventIds = userEvents.map(e => e.getId());
        cachedUserMessages.forEach(msg => {
          if (!eventIds.includes(msg.id)) {
            userEvents.push({ getId: () => msg.id });
          }
        });
      }
      
      if (userEvents.length === 0) {
        this._triggerEvent('error', { 
          context: 'clearMessages', 
          message: 'No messages found to delete' 
        });
        return false;
      }
      
      // Redact all messages
      for (const event of userEvents) {
        await this.client.redactEvent(this.room, event.getId());
        
        // Update cache immediately after each redaction
        if (this.messageCache[this.room]) {
          this.messageCache[this.room] = this.messageCache[this.room].map(msg => {
            if (msg.id === event.getId()) {
              return { ...msg, redacted: true };
            }
            return msg;
          });
        }
      }
      
      // Save cache after all updates
      this._saveMessageCache();
      
      this._triggerEvent('message', {
        sender: this.userId,
        roomId: this.room,
        text: `Cleared ${userEvents.length} messages`,
        type: 'system',
        system: true,
        important: true
      });
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'clearMessages', 
        message: error.message || 'Failed to clear messages' 
      });
      return false;
    }
  }
  
  async leaveRoom() {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'leaveRoom', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      await this.client.leave(this.room);
      
      this.room = null;
      localStorage.removeItem('matrixRoom');
      
      this._triggerEvent('roomLeave');
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'leaveRoom', 
        message: error.message || 'Failed to leave room' 
      });
      return false;
    }
  }
  
  reset() {
    if (this.client) {
      this.client.stopClient();
    }
    
    // Clear all storage except message cache
    localStorage.removeItem('matrixAccessToken');
    localStorage.removeItem('matrixUserId');
    localStorage.removeItem('matrixUsername');
    localStorage.removeItem('matrixPassword');
    localStorage.removeItem('matrixRoom');
    
    // Set a flag in sessionStorage to prevent auto-login on next load
    sessionStorage.setItem('matrixReset', 'true');
    
    // Reset properties
    this.client = null;
    this.room = null;
    this.userId = null;
    this.roomState = {};
    
    // We don't clear message cache on reset to preserve history
    
    return true;
  }

  // NEW: Method to clear message cache if needed
  clearMessageCache() {
    this.messageCache = {};
    localStorage.removeItem('matrixMessageCache');
    return true;
  }

  async sendRoll(notation) {
    if (!this.client || !this.room) {
      this._triggerEvent('error', { 
        context: 'sendRoll', 
        message: 'Not in a room or not logged in' 
      });
      return false;
    }

    try {
      const rollResult = this.rollDice(notation);
      if (!rollResult) {
        this._triggerEvent('error', { 
          context: 'sendRoll', 
          message: 'Invalid dice notation' 
        });
        return false;
      }
      
      // Count hits (even numbers)
      const hits = rollResult.rolls.filter(roll => roll % 2 === 0).length;
      
      // Find highest and lowest rolls
      const highest = Math.max(...rollResult.rolls);
      const lowest = Math.min(...rollResult.rolls);
      
      // Determine if highest and lowest are even or odd
      const highEvenOdd = highest % 2 === 0 ? 'even' : 'odd';
      const lowEvenOdd = lowest % 2 === 0 ? 'even' : 'odd';
      
      // Get user ID without the domain part
      const username = this.userId.split(':')[0];
      
      // Format roll text with hit count and high/low even/odd status
      const rollText = `🎲 @${username} ${notation}: [${rollResult.rolls.join('][')}] = ${hits} hit${hits !== 1 ? 's' : ''}, high ${highEvenOdd}, low ${lowEvenOdd}`;
      
      // Send as a special roll message
      const response = await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: rollText,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: "roll",
          dice: notation,
          rolls: rollResult.rolls,
          hits: hits,
          highEvenOdd: highEvenOdd,
          lowEvenOdd: lowEvenOdd,
          username: username
        }
      });
      
      // Cache our own roll immediately
      const rollObj = {
        id: response.event_id,
        sender: this.userId,
        roomId: this.room,
        text: rollText,
        type: 'roll',
        dice: notation,
        rolls: rollResult.rolls,
        hits: hits,
        highEvenOdd: highEvenOdd,
        lowEvenOdd: lowEvenOdd,
        username: username,
        powerLevel: (this.roomState[this.room] && 
                     this.roomState[this.room].members && 
                     this.roomState[this.room].members[this.userId]) 
                   ? this.roomState[this.room].members[this.userId].powerLevel 
                   : 0,
        timestamp: Date.now(),
        self: true
      };
      
      this._addMessageToCache(this.room, rollObj);
      
      return true;
    } catch (error) {
      this._triggerEvent('error', { 
        context: 'sendRoll', 
        message: error.message || 'Failed to send roll' 
      });
      return false;
    }
  }

  rollDice(notation) {
    // Parse dice notation like "2d6"
    const match = notation.match(/^(\d+)d(\d+)$/);
    if (!match) return null;
    
    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    
    // Validate limits to prevent abuse
    if (count > 100 || sides > 1000) return null;
    
    const rolls = Array(count).fill(0).map(() => 
      Math.floor(Math.random() * sides) + 1
    );
    
    return {
      rolls,
      total: rolls.reduce((a, b) => a + b, 0)
    };
  }

  // Command processing
  async processCommand(input, type = 'chat') {
    if (!input) return false;
    
    // Process commands
    if (input.startsWith('/login ')) {
      const [_, username, password] = input.split(' ');
      if (!username || !password) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Usage: /login username password' 
        });
        return { success: false };
      }
      
      return await this.login(username, password);
    }
    
    else if (input.startsWith('/join ')) {
      const parts = input.split(' ');
      const roomId = parts[1];
      const inviteCode = parts[2] || null;
      
      if (!roomId) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Usage: /join #room:matrix.org [INVITE_CODE]' 
        });
        return false;
      }
      
      return await this.joinRoom(roomId, inviteCode);
    }
    
    else if (input.startsWith('/leave')) {
      if (!this.room) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Not in a room' 
        });
        return false;
      }
      
      return await this.leaveRoom();
    }
    
    else if (input.startsWith('/reset')) {
      return this.reset();
    }
    
    else if (input.startsWith('/clear-cache')) {
      return this.clearMessageCache();
    }
    
    else if (input.startsWith('/roll ')) {
      const notation = input.split(' ')[1];
      if (!notation || !notation.match(/^\d+d\d+$/)) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Usage: /roll XdY (e.g., /roll 2d6)' 
        });
        return false;
      }
      
      return await this.sendRoll(notation);
    }
    
    else if (input.startsWith('/scene ')) {
      // Get scene name (everything after /scene)
      const sceneName = input.substring(7).trim();
      if (!sceneName) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Usage: /scene Scene Name' 
        });
        return false;
      }
      
      return await this.sendScene(sceneName, 'regular');
    }
    
    else if (input === 'narrate' || input.startsWith('narrate ')) {
      // Get narration text (everything after 'narrate ')
      const narrationText = input === 'narrate' ? '' : input.substring(8).trim();
      if (!narrationText) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Usage: narrate Your narration text' 
        });
        return false;
      }
      
      return await this.sendNarration(narrationText);
    }
    
    else if (input.startsWith('/narrate ')) {
      // Get narration text (everything after /narrate)
      const narrationText = input.substring(9).trim();
      if (!narrationText) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Usage: /narrate Your narration text' 
        });
        return false;
      }
      
      return await this.sendNarration(narrationText);
    }
    
    else if (input.startsWith('/delete')) {
      if (!this.room) {
        this._triggerEvent('error', { 
          context: 'command', 
          message: 'Not in a room' 
        });
        return false;
      }
      return await this.deleteLastMessage();
    }
    
    else if (input.startsWith('/logout')) {
      this.logout();
      return { success: false, logout: true };
    }
    
    else if (input.startsWith('/')) {
      this._triggerEvent('error', { 
        context: 'command', 
        message: 'Unknown command' 
      });
      return false;
    }
    
    // Regular message
    else {
      return await this.sendMessage(input, type);
    }
  }

  // Event listeners
  setupClientListeners() {
    if (!this.client) return;
    
    this.client.on('Room.timeline', (event, room) => {
      // Only process messages if they're from our actively joined room
      if (room.roomId !== this.room) return;
      
      if (event.getType() === 'm.room.message' && !event.isRedacted()) {
        const content = event.getContent();
        const sender = event.getSender();
        const roomId = room.roomId;
        const eventId = event.getId();
        
        // Skip if we already have this event in cache (prevents duplicates)
        if (this.messageCache[roomId] && 
            this.messageCache[roomId].some(m => m.id === eventId)) {
          return;
        }
        
        // Get power level
        let powerLevel = 0;
        if (this.roomState[roomId] && 
            this.roomState[roomId].members && 
            this.roomState[roomId].members[sender]) {
          powerLevel = this.roomState[roomId].members[sender].powerLevel;
        }
        
        // Determine message type
        const messageType = content.formatted_body?.type || 'chat'; // Default to chat
        
        // Prepare base message object for caching
        const messageObj = {
          id: eventId,
          sender,
          roomId,
          text: content.body,
          type: messageType,
          powerLevel,
          timestamp: event.getTs(),
          self: sender === this.userId
        };
        
        // Check if it's a roll message
        if (content.format === 'org.matrix.custom.rpg' && messageType === 'roll') {
          // Add roll-specific fields
          messageObj.dice = content.formatted_body.dice;
          messageObj.rolls = content.formatted_body.rolls;
          messageObj.hits = content.formatted_body.hits;
          messageObj.highEvenOdd = content.formatted_body.highEvenOdd;
          messageObj.lowEvenOdd = content.formatted_body.lowEvenOdd;
          messageObj.username = content.formatted_body.username;
          
          // Cache message
          this._addMessageToCache(roomId, messageObj);
          
          // Handle roll message
          this._triggerEvent('roll', messageObj);
        }
        // Check if it's a scene message
        else if (content.format === 'org.matrix.custom.rpg' && messageType === 'scene') {
          // Add scene-specific fields
          messageObj.sceneName = content.formatted_body.sceneName;
          messageObj.sceneType = content.formatted_body.sceneType;
          
          // Cache message
          this._addMessageToCache(roomId, messageObj);
          
          // Trigger event
          this._triggerEvent('scene', messageObj);
        } 
        // Check if it's a narration message
        else if (content.format === 'org.matrix.custom.rpg' && messageType === 'narrate') {
          // Cache message
          this._addMessageToCache(roomId, messageObj);
          
          // Trigger event
          this._triggerEvent('message', messageObj);
        }
        else {
          // Handle regular message
          // Cache message
          this._addMessageToCache(roomId, messageObj);
          
          // Trigger event
          this._triggerEvent('message', messageObj);
        }
      }
      // Handle redactions to update our cache
      else if (event.getType() === 'm.room.redaction') {
        const redactedId = event.getAssociatedId();
        if (redactedId && this.messageCache[room.roomId]) {
          // Mark as redacted in cache
          this.messageCache[room.roomId] = this.messageCache[room.roomId].map(msg => {
            if (msg.id === redactedId) {
              return { ...msg, redacted: true };
            }
            return msg;
          });
          this._saveMessageCache();
        }
      }
      
      // Handle room member changes to update power levels
      if (event.getType() === 'm.room.member' || event.getType() === 'm.room.power_levels') {
        this._updateRoomState(room.roomId);
      }
    });
    
    // Handle connection errors
    this.client.on('sync.error', (error) => {
      this._triggerEvent('error', { 
        context: 'sync', 
        message: error.message || 'Sync error' 
      });
    });
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
    return this; // For chaining
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
    return this; // For chaining
  }

  _triggerEvent(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(data));
    }
  }
}