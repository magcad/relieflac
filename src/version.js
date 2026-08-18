// Version de l'application, à incrémenter à chaque déploiement.
//
// Elle est figée dans ce module, mis en cache par le navigateur comme tous les autres :
// si l'écran affiche encore l'ancien numéro après un rechargement, c'est que le téléphone
// sert toujours une version périmée depuis son cache. C'est le témoin qui permet de le
// vérifier d'un coup d'œil, notamment sur un PWA iOS ajouté à l'écran d'accueil.
export const VERSION = '2026-08-18.6';
