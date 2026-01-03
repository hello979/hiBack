const GoogleStrategy = require('passport-google-oauth20').Strategy;
const JwtStrategy = require('passport-jwt').Strategy; // <--- NEW IMPORT
const ExtractJwt = require('passport-jwt').ExtractJwt; // <--- NEW IMPORT
const User = require('../models/users');

module.exports = function (passport) {
  
  // ============================================================
  // STRATEGY 1: GOOGLE OAUTH (For Login)
  // ============================================================
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          // 1. Check if user exists by Google ID
          let user = await User.findOne({ googleId: profile.id });
          if (user) return done(null, user);

          // 2. Check if user exists by EMAIL (Link Account)
          const userEmail = profile.emails[0].value;
          user = await User.findOne({ email: userEmail });

          if (user) {
            user.googleId = profile.id;
            await user.save();
            return done(null, user);
          } 
          
          // 3. Create new user
          const newUser = {
            googleId: profile.id,
            username: profile.displayName.split(' ').join('_'), 
            email: userEmail,
          };
          user = await User.create(newUser);
          return done(null, user);
        } catch (err) {
          console.error(err);
          return done(err, null);
        }
      }
    )
  );

  // ============================================================
  // STRATEGY 2: JWT TOKEN (For Protecting API Routes) <--- THIS WAS MISSING
  // ============================================================
  const opts = {};
  // Look for the token in the 'Authorization: Bearer <token>' header
  opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
  // Decode using your secret key from .env
  opts.secretOrKey = process.env.JWT_SECRET;

  passport.use(
    new JwtStrategy(opts, async (jwt_payload, done) => {
      try {
        // Find the user specified in the token payload
        // Note: jwt_payload.id must match how you signed the token (usually user._id)
        const user = await User.findById(jwt_payload.id);
        
        if (user) {
          return done(null, user); // Success: req.user is now set
        }
        return done(null, false); // Fail: Token valid, but user not found
      } catch (err) {
        console.error(err);
        return done(err, false);
      }
    })
  );
};