/**
 * Knowledge Graph Service
 * 
 * Maintains a tree structure for meetings and related content (emails, tasks, etc.)
 * - Meeting nodes as root nodes
 * - Related emails, tasks, transcripts as child nodes
 * - Supports querying "latest updates" from a topic branch
 */

const mongoose = require('mongoose');

// ============================================
// KNOWLEDGE NODE SCHEMA
// ============================================
const KnowledgeNodeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  
  // Node identification
  nodeType: { 
    type: String, 
    enum: ['meeting', 'email', 'task', 'transcript', 'note', 'document'],
    required: true 
  },
  
  // Reference to actual data
  refId: { type: String, required: true }, // meeting_id, email_id, task_id, etc.
  
  // Parent relationship (for tree structure)
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeNode', default: null },
  rootTopicId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeNode', default: null }, // Always points to root meeting
  
  // Content for search
  title: { type: String, required: true },
  summary: { type: String },
  keywords: [String],
  
  // Topic matching
  topics: [String], // Extracted topics for matching (e.g., "shastra", "product review")
  
  // Metadata
  sourceDate: { type: Date, default: Date.now },
  participants: [String], // Emails of people involved
  
  // Scores and matching
  relevanceScore: { type: Number, default: 0 },
  
}, { timestamps: true });

// Indexes for efficient querying
KnowledgeNodeSchema.index({ userId: 1, topics: 1 });
KnowledgeNodeSchema.index({ userId: 1, rootTopicId: 1, createdAt: -1 });
KnowledgeNodeSchema.index({ userId: 1, nodeType: 1 });
KnowledgeNodeSchema.index({ userId: 1, refId: 1 });

const KnowledgeNode = mongoose.model('KnowledgeNode', KnowledgeNodeSchema);

class KnowledgeGraphService {
  
  // ============================================
  // EXTRACT TOPICS FROM TEXT
  // ============================================
  extractTopics(text) {
    if (!text) return [];
    
    // Simple keyword extraction - in production, use NLP
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very', 'just', 'about', 'meeting', 'email', 'call', 'today', 'tomorrow', 'yesterday']);
    
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));
    
    // Count frequency
    const freq = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    
    // Return top keywords
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  // ============================================
  // INDEX MEETING (Root Node)
  // ============================================
  async indexMeeting(userId, meeting) {
    try {
      const topics = this.extractTopics(
        `${meeting.title || meeting.meeting_title} ${meeting.summary || ''}`
      );
      
      // Check if already exists
      let node = await KnowledgeNode.findOne({ 
        userId, 
        nodeType: 'meeting', 
        refId: meeting.meeting_id || meeting.id 
      });
      
      if (node) {
        // Update existing
        node.title = meeting.title || meeting.meeting_title;
        node.summary = meeting.summary;
        node.topics = topics;
        node.participants = meeting.attendees || [];
        node.sourceDate = meeting.start_time || meeting.start || new Date();
        await node.save();
      } else {
        // Create new
        node = await KnowledgeNode.create({
          userId,
          nodeType: 'meeting',
          refId: meeting.meeting_id || meeting.id,
          parentId: null,
          rootTopicId: null, // Will be set to self after creation
          title: meeting.title || meeting.meeting_title,
          summary: meeting.summary,
          topics,
          keywords: topics,
          participants: meeting.attendees || [],
          sourceDate: meeting.start_time || meeting.start || new Date()
        });
        
        // Set rootTopicId to self
        node.rootTopicId = node._id;
        await node.save();
      }
      
      console.log(`[KnowledgeGraph] Indexed meeting: ${node.title} with topics: ${topics.join(', ')}`);
      return node;
    } catch (error) {
      console.error('[KnowledgeGraph] Index meeting error:', error.message);
      return null;
    }
  }

  // ============================================
  // LINK EMAIL TO MEETING (Child Node)
  // ============================================
  async linkEmailToMeeting(userId, email, meetingNode = null) {
    try {
      const emailTopics = this.extractTopics(
        `${email.subject} ${email.snippet || email.body || ''}`
      );
      
      // If no meeting node provided, find matching meeting by topic
      if (!meetingNode) {
        meetingNode = await this.findMatchingMeeting(userId, emailTopics);
      }
      
      const node = await KnowledgeNode.create({
        userId,
        nodeType: 'email',
        refId: email.id || email.messageId,
        parentId: meetingNode?._id || null,
        rootTopicId: meetingNode?.rootTopicId || meetingNode?._id || null,
        title: email.subject,
        summary: email.snippet?.substring(0, 300),
        topics: emailTopics,
        keywords: emailTopics,
        participants: [email.fromEmail, email.to].filter(Boolean),
        sourceDate: email.date || new Date()
      });
      
      if (meetingNode) {
        console.log(`[KnowledgeGraph] Linked email "${email.subject}" to meeting "${meetingNode.title}"`);
      } else {
        console.log(`[KnowledgeGraph] Indexed standalone email "${email.subject}"`);
      }
      
      return node;
    } catch (error) {
      console.error('[KnowledgeGraph] Link email error:', error.message);
      return null;
    }
  }

  // ============================================
  // LINK TASK TO MEETING
  // ============================================
  async linkTaskToMeeting(userId, task, meetingNode = null) {
    try {
      // If meeting_id provided, find the meeting node
      if (task.meeting_id && !meetingNode) {
        meetingNode = await KnowledgeNode.findOne({
          userId,
          nodeType: 'meeting',
          refId: task.meeting_id
        });
      }
      
      const topics = this.extractTopics(task.description);
      
      const node = await KnowledgeNode.create({
        userId,
        nodeType: 'task',
        refId: task.task_id || task._id?.toString(),
        parentId: meetingNode?._id || null,
        rootTopicId: meetingNode?.rootTopicId || meetingNode?._id || null,
        title: task.description?.substring(0, 100),
        summary: task.description,
        topics,
        keywords: topics,
        participants: task.assignees?.map(a => a.name) || [],
        sourceDate: task.createdAt || new Date()
      });
      
      console.log(`[KnowledgeGraph] Linked task to meeting: ${meetingNode?.title || 'standalone'}`);
      return node;
    } catch (error) {
      console.error('[KnowledgeGraph] Link task error:', error.message);
      return null;
    }
  }

  // ============================================
  // FIND MATCHING MEETING BY TOPIC
  // ============================================
  async findMatchingMeeting(userId, topics) {
    if (!topics || topics.length === 0) return null;
    
    try {
      // Find meetings with overlapping topics
      const meetings = await KnowledgeNode.find({
        userId,
        nodeType: 'meeting',
        topics: { $in: topics }
      }).sort({ sourceDate: -1 }).limit(5);
      
      if (meetings.length === 0) return null;
      
      // Score by topic overlap
      let bestMatch = null;
      let bestScore = 0;
      
      meetings.forEach(meeting => {
        const overlap = meeting.topics.filter(t => topics.includes(t)).length;
        const score = overlap / Math.max(meeting.topics.length, topics.length);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = meeting;
        }
      });
      
      // Return if score is above threshold
      return bestScore > 0.2 ? bestMatch : null;
    } catch (error) {
      console.error('[KnowledgeGraph] Find matching meeting error:', error.message);
      return null;
    }
  }

  // ============================================
  // GET LATEST UPDATES FOR TOPIC
  // ============================================
  async getLatestUpdates(userId, topicQuery, limit = 5) {
    try {
      const queryTopics = this.extractTopics(topicQuery);
      
      // Find root meeting node for this topic
      const rootMeeting = await this.findMatchingMeeting(userId, queryTopics);
      
      if (rootMeeting) {
        // Get all nodes in this branch
        const branchNodes = await KnowledgeNode.find({
          userId,
          $or: [
            { _id: rootMeeting._id },
            { rootTopicId: rootMeeting._id }
          ]
        }).sort({ sourceDate: -1 }).limit(limit);
        
        return {
          topic: rootMeeting.title,
          rootMeetingId: rootMeeting.refId,
          nodes: branchNodes.map(n => ({
            type: n.nodeType,
            title: n.title,
            summary: n.summary,
            date: n.sourceDate,
            refId: n.refId
          }))
        };
      }
      
      // No matching meeting, search across all nodes
      const nodes = await KnowledgeNode.find({
        userId,
        topics: { $in: queryTopics }
      }).sort({ sourceDate: -1 }).limit(limit);
      
      return {
        topic: topicQuery,
        rootMeetingId: null,
        nodes: nodes.map(n => ({
          type: n.nodeType,
          title: n.title,
          summary: n.summary,
          date: n.sourceDate,
          refId: n.refId
        }))
      };
    } catch (error) {
      console.error('[KnowledgeGraph] Get latest updates error:', error.message);
      return { topic: topicQuery, nodes: [] };
    }
  }

  // ============================================
  // GET MEETING CONTEXT (Full Branch)
  // ============================================
  async getMeetingContext(userId, meetingId) {
    try {
      const meetingNode = await KnowledgeNode.findOne({
        userId,
        nodeType: 'meeting',
        refId: meetingId
      });
      
      if (!meetingNode) return null;
      
      // Get all child nodes
      const children = await KnowledgeNode.find({
        userId,
        rootTopicId: meetingNode._id,
        _id: { $ne: meetingNode._id }
      }).sort({ sourceDate: -1 });
      
      return {
        meeting: {
          id: meetingNode.refId,
          title: meetingNode.title,
          summary: meetingNode.summary,
          date: meetingNode.sourceDate,
          topics: meetingNode.topics
        },
        relatedEmails: children.filter(c => c.nodeType === 'email'),
        relatedTasks: children.filter(c => c.nodeType === 'task'),
        relatedNotes: children.filter(c => c.nodeType === 'note'),
        relatedTranscripts: children.filter(c => c.nodeType === 'transcript')
      };
    } catch (error) {
      console.error('[KnowledgeGraph] Get meeting context error:', error.message);
      return null;
    }
  }

  // ============================================
  // AUTO-LINK NEW EMAILS TO MEETINGS
  // ============================================
  async autoLinkEmail(userId, email) {
    const emailTopics = this.extractTopics(
      `${email.subject} ${email.snippet || email.body || ''}`
    );
    
    const matchingMeeting = await this.findMatchingMeeting(userId, emailTopics);
    
    if (matchingMeeting) {
      await this.linkEmailToMeeting(userId, email, matchingMeeting);
      return matchingMeeting;
    }
    
    // Index as standalone
    await this.linkEmailToMeeting(userId, email, null);
    return null;
  }
}

module.exports = new KnowledgeGraphService();
