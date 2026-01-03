const { MemoryClient } = require('mem0ai');

const mem0 = new MemoryClient({ 
  apiKey: process.env.MEM0_API_KEY 
});

class Mem0Service {
  constructor() {
    this.client = mem0;
  }

  // ============================================
  // EMAIL INDEXING
  // ============================================
  async indexEmail(email, userId) {
    const memoryText = `Email from ${email.from}: "${email.subject}". Summary: ${email.snippet}`;
    
    await this.client.add(
      [{ role: "user", content: memoryText }], 
      {
        user_id: userId,
        metadata: {
          source: "gmail",
          messageId: email.id,
          threadId: email.threadId,
          date: email.date || new Date().toISOString(),
          type: "communication",
          from: email.from,
          fromEmail: email.fromEmail,
          subject: email.subject
        }
      }
    );
  }

  // ============================================
  // CONTEXT RETRIEVAL (RAG) - Enhanced
  // ============================================
  async getContext(userId, query) {
    try {
      // Search for relevant context
      const searchQuery = typeof query === 'string' ? query : 
        `${query.from || ''} ${query.subject || ''} ${query.snippet || ''}`.slice(0, 500);
      
      const results = await this.client.search(searchQuery, {
        user_id: userId,
        limit: 10
      });

      const sources = results.map(m => ({
        text: m.memory,
        source: m.metadata?.source || 'unknown',
        date: m.metadata?.date || 'unknown',
        type: m.metadata?.type || 'unknown',
        from: m.metadata?.from,
        subject: m.metadata?.subject
      }));

      return {
        facts: sources.map(s => s.text).join('\n'),
        sources,
        preferences: await this.getUserPreferences(userId)
      };
    } catch (error) {
      console.error('Context retrieval error:', error.message);
      return { facts: '', sources: [], preferences: {} };
    }
  }

  // ============================================
  // SEARCH (For Chat) - Enhanced with filtering
  // ============================================
  async search(query, userId, filters = {}) {
    try {
      const response = await this.client.search(query, {
        user_id: userId,
        limit: filters.limit || 10
      });

      let results = response.map(m => ({
        text: m.memory,
        source: m.metadata?.source || 'unknown',
        date: m.metadata?.date || 'unknown',
        type: m.metadata?.type || 'unknown',
        from: m.metadata?.from,
        subject: m.metadata?.subject,
        relevance: m.score
      }));

      // Apply filters
      if (filters.source) {
        results = results.filter(r => r.source === filters.source);
      }
      if (filters.type) {
        results = results.filter(r => r.type === filters.type);
      }
      if (filters.dateAfter) {
        results = results.filter(r => new Date(r.date) >= new Date(filters.dateAfter));
      }

      // Sort by relevance and recency
      results.sort((a, b) => {
        // Prefer more relevant and more recent
        const relevanceWeight = (b.relevance || 0) - (a.relevance || 0);
        const dateWeight = new Date(b.date || 0) - new Date(a.date || 0);
        return relevanceWeight * 0.7 + dateWeight * 0.3;
      });

      return results;
    } catch (error) {
      console.error('Mem0 Search Error:', error.message);
      return [];
    }
  }

  // ============================================
  // ENTITY EXTRACTION & STORAGE
  // ============================================
  async indexEntity(userId, entity) {
    try {
      const entityText = `${entity.type}: ${entity.name}${entity.email ? ` (${entity.email})` : ''}${entity.role ? ` - ${entity.role}` : ''}${entity.company ? ` at ${entity.company}` : ''}`;
      
      await this.client.add(
        [{ role: "user", content: entityText }],
        {
          user_id: userId,
          metadata: {
            type: 'entity',
            entityType: entity.type, // 'person', 'company', 'project', 'document'
            name: entity.name,
            email: entity.email,
            role: entity.role,
            company: entity.company,
            source: entity.source || 'learned',
            date: new Date().toISOString()
          }
        }
      );
      console.log(`[Mem0] Indexed entity: ${entity.name} (${entity.type})`);
    } catch (error) {
      console.error('Entity indexing error:', error.message);
    }
  }

  // ============================================
  // FIND ENTITY (For disambiguation)
  // ============================================
  async findEntity(userId, name, type = null) {
    try {
      const results = await this.client.search(`${type || 'person'}: ${name}`, {
        user_id: userId,
        limit: 5
      });

      return results
        .filter(r => r.metadata?.type === 'entity')
        .map(r => ({
          name: r.metadata?.name,
          email: r.metadata?.email,
          role: r.metadata?.role,
          company: r.metadata?.company,
          type: r.metadata?.entityType
        }));
    } catch (error) {
      console.error('Find entity error:', error.message);
      return [];
    }
  }

  // ============================================
  // USER PREFERENCES (Adaptive Learning) - Enhanced
  // ============================================
  async getUserPreferences(userId) {
    try {
      const prefs = await this.client.search('user preferences settings style', {
        user_id: userId,
        limit: 20
      });
      
      const preferences = {
        emailStyle: {},
        scheduling: {},
        contacts: {},
        general: {}
      };
      
      prefs.forEach(p => {
        if (p.metadata?.type === 'preference') {
          const key = p.metadata?.key;
          const category = p.metadata?.category || 'general';
          const scope = p.metadata?.scope || 'global';
          
          if (!preferences[category]) preferences[category] = {};
          
          if (scope.startsWith('contact:')) {
            const email = scope.replace('contact:', '');
            if (!preferences.contacts[email]) preferences.contacts[email] = {};
            preferences.contacts[email][key] = p.memory;
          } else {
            preferences[category][key] = p.memory;
          }
        }
      });
      
      return preferences;
    } catch (error) {
      return {};
    }
  }

  // ============================================
  // LEARN PREFERENCE (From user actions) - Enhanced
  // ============================================
  async learnPreference(userId, preference, key = null, options = {}) {
    try {
      await this.client.add(
        [{ role: "user", content: `User preference: ${preference}` }],
        {
          user_id: userId,
          metadata: {
            type: 'preference',
            key: key || preference.slice(0, 50),
            category: options.category || 'general',
            scope: options.scope || 'global',
            source: options.source || 'learned',
            confidence: options.confidence || 0.8,
            date: new Date().toISOString()
          }
        }
      );
      console.log(`[Mem0] Learned preference for ${userId}: ${key || preference.slice(0, 30)}`);
    } catch (error) {
      console.error('Learn preference error:', error.message);
    }
  }

  // ============================================
  // LEARN FROM USER CORRECTION
  // ============================================
  async learnCorrection(userId, correction) {
    try {
      // Store the correction as a high-priority preference
      await this.client.add(
        [{ role: "user", content: `Correction: ${correction.original} should be ${correction.corrected}. Context: ${correction.context}` }],
        {
          user_id: userId,
          metadata: {
            type: 'correction',
            original: correction.original,
            corrected: correction.corrected,
            context: correction.context,
            source: 'user_correction',
            confidence: 1.0,
            date: new Date().toISOString()
          }
        }
      );
      console.log(`[Mem0] Learned correction for ${userId}: ${correction.original} -> ${correction.corrected}`);
    } catch (error) {
      console.error('Learn correction error:', error.message);
    }
  }

  // ============================================
  // INDEX CALENDAR EVENT
  // ============================================
  async indexCalendarEvent(event, userId) {
    const attendees = event.attendees?.map(a => a.email || a).join(', ') || 'None';
    const memoryText = `Meeting: "${event.summary || event.title}" on ${event.start}. Attendees: ${attendees}. ${event.description || ''}`;
    
    await this.client.add(
      [{ role: "user", content: memoryText }],
      {
        user_id: userId,
        metadata: {
          source: 'google_calendar',
          eventId: event.id,
          date: event.start,
          type: 'meeting',
          title: event.summary || event.title,
          attendees: attendees
        }
      }
    );
  }

  // ============================================
  // INDEX CONVERSATION SUMMARY
  // ============================================
  async indexConversationSummary(userId, summary) {
    try {
      await this.client.add(
        [{ role: "user", content: `Conversation summary: ${summary.text}` }],
        {
          user_id: userId,
          metadata: {
            type: 'conversation_summary',
            source: 'chat',
            topics: summary.topics,
            entities: summary.entities,
            date: new Date().toISOString()
          }
        }
      );
    } catch (error) {
      console.error('Index conversation summary error:', error.message);
    }
  }

  // ============================================
  // GET ALL CONTEXT FOR BRIEFING
  // ============================================
  async getAllRecent(userId, limit = 20) {
    try {
      const results = await this.client.getAll({ user_id: userId, limit });
      return results.map(m => ({
        text: m.memory,
        source: m.metadata?.source,
        date: m.metadata?.date,
        type: m.metadata?.type
      }));
    } catch (error) {
      console.error('Get all error:', error.message);
      return [];
    }
  }

  // ============================================
  // DELETE USER DATA (Right to be forgotten)
  // ============================================
  async deleteUserData(userId) {
    try {
      await this.client.deleteAll({ user_id: userId });
      console.log(`[Mem0] Deleted all data for user ${userId}`);
      return true;
    } catch (error) {
      console.error('Delete user data error:', error.message);
      return false;
    }
  }
}

module.exports = new Mem0Service();