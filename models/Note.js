const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema({
  meetingId: { type: String, required: false },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  
  shareId: { type: String, unique: true, sparse: true } 
});

module.exports = mongoose.model('Note', NoteSchema);