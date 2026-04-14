using UnityEngine;
namespace Game {
    /// <summary>Drives the player each frame.</summary>
    public class Controller : MonoBehaviour {
        private Player player;
        void Update() {
            player.Move(Time.deltaTime);
        }
    }
}
