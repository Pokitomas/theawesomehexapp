import { Client } from './client.js';
import { Auth } from './auth.js';
import { Posts } from './posts.js';
import { Graph } from './graph.js';
import { Feeds } from './feeds.js';
import { Notifications } from './notifications.js';
import { Sync } from './sync.js';
import { Schema } from './schema.js';

const profile = Object.freeze({
  identity: Auth.currentIdentity,
  get: Auth.user,
  update: Auth.updateProfile,
  preferences: () => window.SidewaysWorkspace?.profile?.() || {}
});

export const SidewaysNetwork = Object.freeze({
  session: Object.freeze({ current: Client.session, signedIn: Auth.signedIn, signup: Auth.signup, login: Auth.login, logout: Auth.logout, refresh: Auth.me }),
  profile,
  posts: Posts,
  graph: Graph,
  feeds: Feeds,
  notifications: Notifications,
  sync: Sync,
  schema: Schema
});

window.SidewaysNetwork = SidewaysNetwork;
window.dispatchEvent(new CustomEvent('sideways:networkready', { detail: { signedIn: Auth.signedIn() } }));
