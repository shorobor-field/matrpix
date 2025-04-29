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
    
    // Load saved room
    this.room = localStorage.getItem('matrixRoom');
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
      
      // Load room history
      await this._loadRoomHistory(room.roomId);
      
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

  async _loadRoomHistory(roomId) {
    try {
      const room = this.client.getRoom(roomId);
      if (!room) return false;
      
      // Store processed events to avoid duplicates
      const processedEvents = new Set();
      
      // Function to process a batch of events
      const processEvents = (events) => {
        events.forEach(event => {
          const eventId = event.getId();
          
          // Skip processed or redacted events
          if (processedEvents.has(eventId) || event.isRedacted()) return;
          
          processedEvents.add(eventId);
          
          if (event.getType() === 'm.room.message') {
            const content = event.getContent();
            const sender = event.getSender();
            
            // Get power level
            let powerLevel = 0;
            if (this.roomState[roomId] && 
                this.roomState[roomId].members && 
                this.roomState[roomId].members[sender]) {
              powerLevel = this.roomState[roomId].members[sender].powerLevel;
            }
            
            // Check the message type
            const messageType = content.formatted_body?.type || 'chat'; // Default to chat
            
            // Check if it's a roll message
            if (content.format === 'org.matrix.custom.rpg' && messageType === 'roll') {
              // Handle roll message
              this._triggerEvent('roll', {
                sender,
                roomId,
                text: content.body,
                dice: content.formatted_body.dice,
                rolls: content.formatted_body.rolls,
                hits: content.formatted_body.hits,
                highEvenOdd: content.formatted_body.highEvenOdd,
                lowEvenOdd: content.formatted_body.lowEvenOdd,
                powerLevel,
                historical: true
              });
            } 
            // Check if it's a scene message
            else if (content.format === 'org.matrix.custom.rpg' && messageType === 'scene') {
              this._triggerEvent('scene', {
                sender,
                roomId,
                text: content.body,
                sceneName: content.formatted_body.sceneName,
                sceneType: content.formatted_body.sceneType,
                powerLevel,
                historical: true
              });
            }
            // Check if it's a narration message
            else if (content.format === 'org.matrix.custom.rpg' && messageType === 'narrate') {
              this._triggerEvent('message', {
                sender,
                roomId,
                text: content.body,
                type: 'narrate',
                powerLevel,
                historical: true
              });
            }
            else {
              // Handle regular message
              this._triggerEvent('message', {
                sender,
                roomId,
                text: content.body,
                type: messageType, // 'game' or 'chat'
                powerLevel,
                historical: true
              });
            }
          }
        });
      };
      
      // Initial timeline events
      const timeline = room.getLiveTimeline().getEvents();
      processEvents(timeline);
      
      // Load historical messages through pagination
      const loadMoreHistory = async () => {
        try {
          // Check if we can paginate backwards
          const timelineWindow = this.client.createTimelineWindow(
            room.getEventTimeline(room.getLiveTimeline().getEvents()[0]),
            50 // Batch size
          );
          
          // If we can paginate, load more history
          if (timelineWindow.canPaginate('b')) {
            await timelineWindow.paginate('b', 50);
            const events = timelineWindow.getEvents();
            processEvents(events);
            
            // Continue loading if we can still paginate
            if (timelineWindow.canPaginate('b')) {
              // Use setTimeout to prevent blocking the main thread
              setTimeout(() => loadMoreHistory(), 100);
            }
          }
        } catch (error) {
          // Handle rate limiting or other errors
          console.error('Error loading more history:', error);
          // If rate limited, wait a bit longer
          if (error.errcode === 'M_LIMIT_EXCEEDED') {
            const retryAfter = error.data?.retry_after_ms || 5000;
            setTimeout(() => loadMoreHistory(), retryAfter);
          }
        }
      };
      
      // Start loading history
      await loadMoreHistory();
      
      return true;
    } catch (error) {
      console.error('Error loading room history:', error);
      return false;
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
      // Send message with custom format to indicate type - no need to replace + anymore
      await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: type // 'game' or 'chat'
        }
      });
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
      await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: sceneText,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: "scene",
          sceneName: sceneName,
          sceneType: sceneType
        }
      });
      
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
      await this.client.sendEvent(this.room, "m.room.message", {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.rpg",
        formatted_body: {
          type: "narrate"
        }
      });
      
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
        this._triggerEvent('error', { 
          context: 'deleteMessage', 
          message: 'No messages found to delete' 
        });
        return false;
      }
      
      // Redact the message
      await this.client.redactEvent(this.room, lastMessageEvent.getId());
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
      }
      
      this._triggerEvent('message', {
        sender: this.userId,
        roomId: this.room,
        text: `Cleared ${userEvents.length} messages`,
        type: 'system',
        system: true
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
    
    // Clear all storage
    localStorage.clear();
    
    // Set a flag in sessionStorage to prevent auto-login on next load
    sessionStorage.setItem('matrixReset', 'true');
    
    // Reset properties
    this.client = null;
    this.room = null;
    this.userId = null;
    this.roomState = {};
    
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
      await this.client.sendEvent(this.room, "m.room.message", {
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
        
        // Get power level
        let powerLevel = 0;
        if (this.roomState[roomId] && 
            this.roomState[roomId].members && 
            this.roomState[roomId].members[sender]) {
          powerLevel = this.roomState[roomId].members[sender].powerLevel;
        }
        
        // Determine message type
        const messageType = content.formatted_body?.type || 'chat'; // Default to chat
        
        // Check if it's a roll message
        if (content.format === 'org.matrix.custom.rpg' && messageType === 'roll') {
          // Handle roll message
          this._triggerEvent('roll', {
            sender,
            roomId,
            text: content.body,
            dice: content.formatted_body.dice,
            rolls: content.formatted_body.rolls,
            hits: content.formatted_body.hits,
            highEvenOdd: content.formatted_body.highEvenOdd,
            lowEvenOdd: content.formatted_body.lowEvenOdd,
            username: content.formatted_body.username,
            powerLevel
          });
        }
        // Check if it's a scene message
        else if (content.format === 'org.matrix.custom.rpg' && messageType === 'scene') {
          this._triggerEvent('scene', {
            sender,
            roomId,
            text: content.body,
            sceneName: content.formatted_body.sceneName,
            sceneType: content.formatted_body.sceneType,
            powerLevel
          });
        } 
        // Check if it's a narration message
        else if (content.format === 'org.matrix.custom.rpg' && messageType === 'narrate') {
          this._triggerEvent('message', {
            sender,
            roomId,
            text: content.body,
            type: 'narrate',
            powerLevel
          });
        }
        else {
          // Handle regular message
          this._triggerEvent('message', {
            sender,
            roomId,
            text: content.body,
            type: messageType,
            powerLevel
          });
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