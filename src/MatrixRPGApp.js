// MatrixRPGApp.js
import React, { useState, useEffect, useRef } from 'react';
import { MatrixRPGClient } from './MatrixRPGClient';

const MatrixRPGApp = () => {
  const [view, setView] = useState('game');
  const [input, setInput] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [gameMessages, setGameMessages] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [inRoom, setInRoom] = useState(false);
  const [error, setError] = useState(null);
  const [username, setUsername] = useState('');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitioningTo, setTransitioningTo] = useState(null);
  const [hasUnreadGame, setHasUnreadGame] = useState(false);
  const [hasUnreadChat, setHasUnreadChat] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  
  const clientRef = useRef(null);
  const messagesEndRef = useRef(null);
  const lastMessageCountRef = useRef({ game: 0, chat: 0 });
  const tabHasFocusRef = useRef(true);

  // User colors - For consistent styling
  const USER_COLORS = [
    '#2E6978', // Midnight blue
    '#5D4A7E', // Deep purple
    '#3D6647', // Forest green
    '#7D3956', // Mulberry
  ];

  // Setup window focus/blur event listeners for notifications
  useEffect(() => {
    const handleBlur = () => {
      tabHasFocusRef.current = false;
    };
    
    const handleFocus = () => {
      tabHasFocusRef.current = true;
      
      // Clear unread indicators when tab gets focus
      if (view === 'game') {
        setHasUnreadGame(false);
      } else {
        setHasUnreadChat(false);
      }
    };
    
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, [view]);
  
  // Request notification permissions on startup
  useEffect(() => {
    const requestNotificationPermission = async () => {
      if (!("Notification" in window)) {
        console.log("This browser does not support notifications");
        return;
      }
      
      if (Notification.permission === "granted") {
        setNotificationsEnabled(true);
      } else if (Notification.permission !== "denied") {
        // Ask for permission immediately on startup
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
          setNotificationsEnabled(true);
        }
      }
    };
    
    requestNotificationPermission();
  }, []);

  // Simple color assignment function based on user ID
  const assignColor = (userId) => {
    // Use the user's ID to deterministically assign a color
    const colorIndex = Math.abs(userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % USER_COLORS.length;
    return USER_COLORS[colorIndex];
  };

  // Initialize client on component mount
  useEffect(() => {
    clientRef.current = new MatrixRPGClient();
    
    // Set up event listeners - only handle necessary events
    clientRef.current.on('message', handleMessage);
    clientRef.current.on('roll', handleRoll);
    clientRef.current.on('scene', handleScene);
    clientRef.current.on('error', handleError);
    clientRef.current.on('roomJoin', handleRoomJoin);
    clientRef.current.on('roomLeave', handleRoomLeave);
    
    // Only try to log in if there's no reset flag in sessionStorage
    const wasReset = sessionStorage.getItem('matrixReset') === 'true';
    
    if (!wasReset) {
      // Try to login with stored token, but handle everything directly here
      clientRef.current.loginWithToken().then(success => {
        if (success) {
          // Handle everything in one place
          setIsLoggedIn(true);
          setUsername(clientRef.current.userId);
          setInRoom(!!clientRef.current.room);
          
          // Clear messages first
          setGameMessages([]);
          setChatMessages([]);
          
          // Add login message
          const loginMsg = { 
            id: 'login-' + Date.now(),
            text: "logged in successfully.",
            color: '#888888',
            system: true,
            temporary: true,
            isNew: true
          };
          
          setGameMessages([loginMsg]);
          setChatMessages([loginMsg]);
          
          // Remove isNew flag after animation completes
          setTimeout(() => {
            setGameMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, isNew: false} : msg)
            );
            setChatMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, isNew: false} : msg)
            );
          }, 150);
          
          // Add removing class for fade-out before removing
          setTimeout(() => {
            setGameMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, removing: true} : msg)
            );
            setChatMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, removing: true} : msg)
            );
            
            // Remove after fade-out completes
            setTimeout(() => {
              setGameMessages(prev => prev.filter(msg => msg.id !== loginMsg.id));
              setChatMessages(prev => prev.filter(msg => msg.id !== loginMsg.id));
            }, 600);
          }, 4000);
        }
      });
    } else {
      // Clear the reset flag
      sessionStorage.removeItem('matrixReset');
      
      // Add initial login prompt
      const promptMsg = { 
        id: 'initial-prompt',
        text: "Use /login username password to log in.",
        color: '#888888',
        system: true,
        isNew: true
      };
      
      setGameMessages([promptMsg]);
      setChatMessages([promptMsg]);
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setGameMessages(prev => 
          prev.map(msg => msg.id === promptMsg.id ? {...msg, isNew: false} : msg)
        );
        setChatMessages(prev => 
          prev.map(msg => msg.id === promptMsg.id ? {...msg, isNew: false} : msg)
        );
      }, 150);
    }
    
    // Cleanup on unmount
    return () => {
      if (clientRef.current) {
        clientRef.current.off('message', handleMessage);
        clientRef.current.off('roll', handleRoll);
        clientRef.current.off('scene', handleScene);
        clientRef.current.off('error', handleError);
        clientRef.current.off('roomJoin', handleRoomJoin);
        clientRef.current.off('roomLeave', handleRoomLeave);
      }
    };
  }, []);

  // Track message counts for animation purposes
  useEffect(() => {
    lastMessageCountRef.current.game = gameMessages.length;
  }, [gameMessages]);
  
  useEffect(() => {
    lastMessageCountRef.current.chat = chatMessages.length;
  }, [chatMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    
    // Clear unread indicator for current view
    if (view === 'game') {
      setHasUnreadGame(false);
    } else {
      setHasUnreadChat(false);
    }
  }, [gameMessages, chatMessages, view]);

  // Handle view transitions
  const handleViewChange = (newView) => {
    if (view === newView) return;
    
    setIsTransitioning(true);
    setTransitioningTo(newView);
    
    // After a short delay, complete the transition
    setTimeout(() => {
      setView(newView);
      
      // Clear unread indicator for the view we're switching to
      if (newView === 'game') {
        setHasUnreadGame(false);
      } else {
        setHasUnreadChat(false);
      }
      
      // After view has changed, reset transition state
      setTimeout(() => {
        setIsTransitioning(false);
        setTransitioningTo(null);
      }, 100); // Match this with CSS transition duration
    }, 100); // Wait for fade-out before changing view
  };

  // Event handlers
  const handleMessage = (data) => {
    const textColor = assignColor(data.sender);
    
    const messageObj = { 
      id: Date.now().toString(),
      text: data.text,
      color: textColor,
      sender: data.sender,
      isNew: true // Mark as new for animation
    };
    
    // Check if this is our own message
    const isOwnMessage = data.sender === clientRef.current?.userId;
    
    // Add to appropriate view based on message type
    if (data.type === 'game') {
      setGameMessages(prev => [...prev, messageObj]);
      
      // Set unread flag if tab isn't focused and it's not our own message
      if (!isOwnMessage && !data.historical && !tabHasFocusRef.current) {
        setHasUnreadGame(true);
      }
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setGameMessages(prev => 
          prev.map(msg => msg.id === messageObj.id ? {...msg, isNew: false} : msg)
        );
      }, 150);
    } else if (data.type === 'chat') {
      setChatMessages(prev => [...prev, messageObj]);
      
      // Set unread flag if tab isn't focused and it's not our own message
      if (!isOwnMessage && !data.historical && !tabHasFocusRef.current) {
        setHasUnreadChat(true);
      }
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setChatMessages(prev => 
          prev.map(msg => msg.id === messageObj.id ? {...msg, isNew: false} : msg)
        );
      }, 150);
    } else if (data.type === 'narrate') {
      // Narration messages always go to the game channel with specific color
      const narrationObj = { 
        id: Date.now().toString(),
        text: data.text,
        color: '#333333', // Narration color
        sender: data.sender,
        type: 'narrate',
        isNew: true // Mark as new for animation
      };
      
      setGameMessages(prev => [...prev, narrationObj]);
      
      // Set unread flag if tab isn't focused and it's not our own message
      if (!isOwnMessage && !data.historical && !tabHasFocusRef.current) {
        setHasUnreadGame(true);
      }
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setGameMessages(prev => 
          prev.map(msg => msg.id === narrationObj.id ? {...msg, isNew: false} : msg)
        );
      }, 150);
    } else if (data.type === 'system' && data.system) {
      // System messages go to both views
      const systemMsg = {...messageObj, isNew: true, system: true};
      
      setGameMessages(prev => [...prev, systemMsg]);
      setChatMessages(prev => [...prev, systemMsg]);
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setGameMessages(prev => 
          prev.map(msg => msg.id === systemMsg.id ? {...msg, isNew: false} : msg)
        );
        setChatMessages(prev => 
          prev.map(msg => msg.id === systemMsg.id ? {...msg, isNew: false} : msg)
        );
      }, 150);
    }
  };

  const handleRoll = (data) => {
    // Format roll message text with highlighted username
    const senderName = data.sender.split(':')[0];
    
    const rollObj = { 
      id: Date.now().toString(),
      type: 'roll',
      text: data.text,
      color: '#888888', // Rolls always gray
      sender: data.sender,
      username: senderName,
      isNew: true // Mark as new for animation
    };
    
    // Only add rolls to game channel
    setGameMessages(prev => [...prev, rollObj]);
    
    // Check if we should set unread indicator
    const isOwnRoll = data.sender === clientRef.current?.userId;
    
    if (!isOwnRoll && !data.historical && !tabHasFocusRef.current) {
      setHasUnreadGame(true);
    }
    
    // Remove isNew flag after animation completes
    setTimeout(() => {
      setGameMessages(prev => 
        prev.map(msg => msg.id === rollObj.id ? {...msg, isNew: false} : msg)
      );
    }, 150);
  };
  
  const handleScene = (data) => {
    const sceneObj = { 
      id: Date.now().toString(),
      type: 'scene',
      text: data.text,
      sceneName: data.sceneName,
      sceneType: data.sceneType,
      color: '#333333',
      sender: data.sender,
      isNew: true // Mark as new for animation
    };
    
    // Only add scenes to game channel
    setGameMessages(prev => [...prev, sceneObj]);
    
    // Check if we should set unread indicator
    const isOwnScene = data.sender === clientRef.current?.userId;
    
    if (!isOwnScene && !data.historical && !tabHasFocusRef.current) {
      setHasUnreadGame(true);
    }
    
    // Remove isNew flag after animation completes
    setTimeout(() => {
      setGameMessages(prev => 
        prev.map(msg => msg.id === sceneObj.id ? {...msg, isNew: false} : msg)
      );
    }, 150);
  };

  const handleError = (data) => {
    setError(data.message);
    const errorMsgId = Date.now().toString();
    const errorMsg = { 
      id: errorMsgId,
      text: `Error (${data.context}): ${data.message}`, 
      color: '#FF6B6B', 
      system: true,
      isNew: true // Mark as new for animation
    };
    
    // Add error to current view
    if (view === 'game') {
      setGameMessages(prev => [...prev, errorMsg]);
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setGameMessages(prev => 
          prev.map(msg => msg.id === errorMsgId ? {...msg, isNew: false} : msg)
        );
      }, 150);
      
      // After 5 seconds, mark for removal with fade out
      setTimeout(() => {
        setGameMessages(prev => 
          prev.map(msg => msg.id === errorMsgId ? {...msg, removing: true} : msg)
        );
        
        // Then remove after animation completes
        setTimeout(() => {
          setGameMessages(prev => prev.filter(msg => msg.id !== errorMsgId));
        }, 600); // Match with systemFadeOut duration
      }, 5000);
    } else {
      setChatMessages(prev => [...prev, errorMsg]);
      
      // Remove isNew flag after animation completes
      setTimeout(() => {
        setChatMessages(prev => 
          prev.map(msg => msg.id === errorMsgId ? {...msg, isNew: false} : msg)
        );
      }, 150);
      
      // After 5 seconds, mark for removal with fade out
      setTimeout(() => {
        setChatMessages(prev => 
          prev.map(msg => msg.id === errorMsgId ? {...msg, removing: true} : msg)
        );
        
        // Then remove after animation completes
        setTimeout(() => {
          setChatMessages(prev => prev.filter(msg => msg.id !== errorMsgId));
        }, 600); // Match with systemFadeOut duration
      }, 5000);
    }
    
    // Clear error state after 5 seconds
    setTimeout(() => setError(null), 5000);
  };

  const handleRoomJoin = (data) => {
    setInRoom(true);
    
    // Create a single join message
    const joinMsgId = 'join-' + Date.now();
    const joinMsg = { 
      id: joinMsgId,
      text: "Joined room successfully",
      color: '#888888',
      system: true,
      isNew: true // Mark as new for animation
    };
    
    // Clear any join prompts and add join message
    setGameMessages(prev => [
      ...prev.filter(msg => 
        msg.text !== "Joined room successfully" && 
        !msg.text.includes("/join #room:matrix.org")
      ), 
      joinMsg
    ]);
    
    setChatMessages(prev => [
      ...prev.filter(msg => 
        msg.text !== "Joined room successfully" && 
        !msg.text.includes("/join #room:matrix.org")
      ), 
      joinMsg
    ]);
    
    // Remove isNew flag after animation completes
    setTimeout(() => {
      setGameMessages(prev => 
        prev.map(msg => msg.id === joinMsgId ? {...msg, isNew: false} : msg)
      );
      setChatMessages(prev => 
        prev.map(msg => msg.id === joinMsgId ? {...msg, isNew: false} : msg)
      );
    }, 150);
    
    // Add removing class for fade-out before removing
    setTimeout(() => {
      setGameMessages(prev => 
        prev.map(msg => msg.id === joinMsgId ? {...msg, removing: true} : msg)
      );
      setChatMessages(prev => 
        prev.map(msg => msg.id === joinMsgId ? {...msg, removing: true} : msg)
      );
      
      // Remove after fade-out completes
      setTimeout(() => {
        setGameMessages(prev => prev.filter(msg => msg.id !== joinMsgId));
        setChatMessages(prev => prev.filter(msg => msg.id !== joinMsgId));
      }, 600);
    }, 4000);
  };
  
  // Handle room leave
  const handleRoomLeave = () => {
    setInRoom(false);
    
    // Create a single leave message
    const leaveMsgId = 'leave-' + Date.now();
    const leaveMsg = { 
      id: leaveMsgId,
      text: "Left room",
      color: '#888888',
      system: true,
      isNew: true // Mark as new for animation
    };
    
    // Add directly to both views
    setGameMessages(prev => [...prev, leaveMsg]);
    setChatMessages(prev => [...prev, leaveMsg]);
    
    // Remove isNew flag after animation completes
    setTimeout(() => {
      setGameMessages(prev => 
        prev.map(msg => msg.id === leaveMsgId ? {...msg, isNew: false} : msg)
      );
      setChatMessages(prev => 
        prev.map(msg => msg.id === leaveMsgId ? {...msg, isNew: false} : msg)
      );
    }, 150);
    
    // Add removing class for fade-out before removing
    setTimeout(() => {
      setGameMessages(prev => 
        prev.map(msg => msg.id === leaveMsgId ? {...msg, removing: true} : msg)
      );
      setChatMessages(prev => 
        prev.map(msg => msg.id === leaveMsgId ? {...msg, removing: true} : msg)
      );
      
      // Remove after fade-out completes
      setTimeout(() => {
        setGameMessages(prev => prev.filter(msg => msg.id !== leaveMsgId));
        setChatMessages(prev => prev.filter(msg => msg.id !== leaveMsgId));
      }, 600);
    }, 4000);
  };

  // Handle key press to detect Shift+Enter for line breaks
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Insert an actual newline character
        const cursorPosition = e.target.selectionStart;
        const textBeforeCursor = input.substring(0, cursorPosition);
        const textAfterCursor = input.substring(cursorPosition);
      
        setInput(textBeforeCursor + '\n' + textAfterCursor);
      
        // Prevent form submission and maintain cursor position after state update
        e.preventDefault();
        setTimeout(() => {
          e.target.selectionStart = e.target.selectionEnd = cursorPosition + 1;
        }, 0);
      } else {
        // Regular Enter just submits
        handleCommand();
        e.preventDefault();
      }
    }
  };

  // Command handling
  const handleCommand = async () => {
    if (!input.trim()) return;
    
    // Process command without displaying it
    const cmd = input;
    setInput('');
    
    if (clientRef.current) {
      const result = await clientRef.current.processCommand(cmd, view);
      
      // Handle login result directly here
      if (cmd.startsWith('/login') && result && typeof result === 'object') {
        if (result.success) {
          setIsLoggedIn(true);
          setUsername(result.userId);
          setInRoom(!!clientRef.current.room);
          
          // Add login success message
          const loginMsg = { 
            id: 'login-' + Date.now(),
            text: "Logged in successfully.",
            color: '#888888',
            system: true,
            isNew: true // Mark as new for animation
          };
          
          setGameMessages(prev => [...prev.filter(m => !m.text.includes('/login')), loginMsg]);
          setChatMessages(prev => [...prev.filter(m => !m.text.includes('/login')), loginMsg]);
          
          // Remove isNew flag after animation completes
          setTimeout(() => {
            setGameMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, isNew: false} : msg)
            );
            setChatMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, isNew: false} : msg)
            );
          }, 150);
          
          // Add removing class for fade-out before removing
          setTimeout(() => {
            setGameMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, removing: true} : msg)
            );
            setChatMessages(prev => 
              prev.map(msg => msg.id === loginMsg.id ? {...msg, removing: true} : msg)
            );
            
            // Remove after fade-out completes
            setTimeout(() => {
              setGameMessages(prev => prev.filter(msg => msg.id !== loginMsg.id));
              setChatMessages(prev => prev.filter(msg => msg.id !== loginMsg.id));
            }, 600);
          }, 4000);
          
          // Add room join prompt ONLY to the game view
          const promptMsg = { 
            id: 'prompt-' + Date.now(),
            text: "Use /join #room:matrix.org to join a room.",
            color: '#888888',
            system: true,
            isNew: true // Mark as new for animation
          };
          
          // Slight delay to ensure messages appear in correct order
          setTimeout(() => {
            setGameMessages(prev => [...prev, promptMsg]);
            
            // Remove isNew flag after animation completes
            setTimeout(() => {
              setGameMessages(prev => 
                prev.map(msg => msg.id === promptMsg.id ? {...msg, isNew: false} : msg)
              );
            }, 150);
          }, 100);
        }
      }
      
      // Handle logout result directly
      else if (cmd.startsWith('/logout') && result && typeof result === 'object' && result.logout) {
        setIsLoggedIn(false);
        setInRoom(false);
        setUsername('');
        
        // Reset messages
        setGameMessages([]);
        setChatMessages([]);
        
        // Add logout message
        const logoutMsg = { 
          id: 'logout-' + Date.now(),
          text: "Logged out. Use /login username password to log in.",
          color: '#888888',
          system: true,
          isNew: true // Mark as new for animation
        };
        
        setGameMessages([logoutMsg]);
        setChatMessages([logoutMsg]);
        
        // Remove isNew flag after animation completes
        setTimeout(() => {
          setGameMessages(prev => 
            prev.map(msg => msg.id === logoutMsg.id ? {...msg, isNew: false} : msg)
          );
          setChatMessages(prev => 
            prev.map(msg => msg.id === logoutMsg.id ? {...msg, isNew: false} : msg)
          );
        }, 150);
      }
    }
  };

  // Helper for command suggestions
  const getCommandHelp = () => {
    if (!isLoggedIn) {
      return '/login username password';
    } else {
      return inRoom ? 'narrate or /roll 2d6' : '/join #room:matrix.org';
    }
  };

  // Get current messages based on view
  const currentMessages = view === 'game' ? gameMessages : chatMessages;

  // Format special messages
  const renderMessage = (msg, i) => {
    // Make sure to display user colors properly
    const messageColor = msg.color || '#333333';
    
    // Handle scene dividers
    if (msg.type === 'scene') {
      return (
        <div 
          key={i} 
          className={`scene-divider ${msg.sceneType} ${msg.isNew ? 'new-message' : 'static-message'}`}
        >
          {msg.sceneName}
        </div>
      );
    }
    
    // Handle narration - removed the italic styling
    else if (msg.type === 'narrate') {
      return (
        <div 
          key={i} 
          className={`message narration ${msg.isNew ? 'new-message' : 'static-message'}`}
          style={{color: '#333333'}}
        >
          {msg.text}
        </div>
      );
    }
    
    // Handle regular messages
    return (
      <div 
        key={i} 
        className={`message 
          ${msg.system ? 'system-message' : ''} 
          ${msg.temporary ? 'temporary-message' : ''} 
          ${msg.isNew ? 'new-message' : 'static-message'}
          ${msg.removing ? 'removing' : ''}`}
        style={!msg.system ? {color: messageColor} : {}}
      >
        {view === 'chat' && !msg.system && !msg.self && (
          <span className="sender" style={{color: messageColor}}>{msg.sender ? msg.sender.split(':')[0] + ': ' : ''}</span>
        )}
        {/* For roll messages with username highlighting */}
        {msg.type === 'roll' ? (
          <span dangerouslySetInnerHTML={{ 
            __html: msg.text.replace(`@${msg.username}`, `<span class="username-highlight">${msg.username}</span>`) 
          }} />
        ) : (
          <span>{msg.text}</span>
        )}
      </div>
    );
  };

  return (
    <div className="app-container">
      <div className="header">
        <div className="view-tabs">
          <button 
            className={`${view === 'game' ? 'active' : ''} ${hasUnreadGame ? 'has-unread' : ''}`}
            onClick={() => handleViewChange('game')}
          >
            game
          </button>
          <button 
            className={`${view === 'chat' ? 'active' : ''} ${hasUnreadChat ? 'has-unread' : ''}`}
            onClick={() => handleViewChange('chat')}
          >
            chat
          </button>
        </div>
      </div>

      <div 
        className={`messages-container ${isTransitioning ? 'fade-out' : 'fade-in'}`}
      >
        {currentMessages.length === 0 ? (
          <div className="help-text">
            {getCommandHelp()}
          </div>
        ) : (
          <div className="messages">
            {currentMessages.map((msg, i) => renderMessage(msg, i))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="input-container">
        <input 
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getCommandHelp()}
        />
        <button onClick={handleCommand}>
          send
        </button>
      </div>
    </div>
  );
};

export default MatrixRPGApp;